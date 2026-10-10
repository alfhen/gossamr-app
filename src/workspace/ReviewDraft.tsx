import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link } from "../components/Adf";
import { hunkLinesAround } from "../lib/diffHunks";
import { REVIEW_OUTDATED_NOTE, reviewEditProblem } from "../lib/proposals";
import type { ChangedFile, DiffSide, Proposal, ProposalEdit, ReviewComment } from "../types";
import type { DraftCardProps } from "./DraftCard";
import { peekFocusAfterLeaving } from "./peekDrafts";
import { openPullView, sameCommit, usePullDiff, type PullDiffState } from "./pullViewStore";
import { takesBackendText } from "./RewriteDiff";

type Review = Extract<Proposal["intent"], { type: "githubReview" }>;

const BADGE: Record<Proposal["state"]["type"], string> = { pending: "Needs your approval", applying: "Posting…", applied: "Posted", skipped: "Discarded", retired: "Out of date" };

const button = "rounded-md border border-ws-sep2 px-2.5 py-1 text-sm hover:bg-ws-hover disabled:opacity-45 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ws-pip";
const primary = "rounded-md bg-ws-pip px-3.5 py-1.5 text-sm font-semibold text-ws-on-pip shadow-sm hover:brightness-110 disabled:opacity-45 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ws-pip";

/** A comment as the card holds it while the person edits: its words, and whether they dropped it. */
export interface Held extends ReviewComment {
  dropped: boolean;
}

const placeOf = (c: Pick<ReviewComment, "path" | "line">) => `${c.path}:${c.line}`;
const keyOf = (c: ReviewComment) => `${c.path}:${c.line}:${c.side}`;
const held = (r: Review): Held[] => r.comments.map((c) => ({ ...c, dropped: false }));

/** Comment `i` dropped, or restored when it was dropped; a dropped comment keeps its words until the edit is sent. */
export const toggleDropped = (comments: readonly Held[], i: number): Held[] => comments.map((c, j) => (j === i ? { ...c, dropped: !c.dropped } : c));

/**
 * Posts a review draft the person may have edited: their edit is saved first, so what is posted is what the card showed.
 * Resolves with what the post came to; a refused edit rejects and posts nothing.
 */
export async function editThenPost<T>(id: string, edit: ProposalEdit | null, seen: number, to: { saveEdit(id: string, edit: ProposalEdit): Promise<unknown>; post(id: string, revisions: number): Promise<T> }): Promise<T> {
  if (edit) await to.saveEdit(id, edit);
  // The edit is one revision more than the card showed; any other change since refuses the post.
  return to.post(id, seen + (edit ? 1 : 0));
}

/**
 * What the card holds once the draft changed under the person's unsaved edit, from `was` to `now` (Pip revised it, say):
 * the comments `now` has, with the person's words and drops kept on those they had changed, and their summary when they
 * had changed it. A comment the draft no longer has is gone; one it gained comes as it is.
 */
export function followDraft(was: Review, now: Review, summary: string, comments: readonly Held[]): { summary: string; comments: Held[] } {
  const mine = new Map(comments.map((c) => [keyOf(c), c]));
  const before = new Map(was.comments.map((c) => [keyOf(c), c]));
  return {
    summary: summary !== was.summary ? summary : now.summary,
    comments: now.comments.map((c) => {
      const held = mine.get(keyOf(c));
      const old = before.get(keyOf(c));
      return held && old && (held.dropped || held.body !== old.body) ? { ...c, body: held.body, dropped: held.dropped } : { ...c, dropped: false };
    }),
  };
}

/** The person's edit of `review` from what the card holds: only what changed, or null when nothing did. */
export function reviewEdit(review: Review, summary: string, comments: readonly Held[]): ProposalEdit | null {
  const kept = comments.filter((c) => !c.dropped).map(({ path, line, side, body }) => ({ path, line, side, body: body.trim() }));
  const summaryChanged = summary.trim() !== review.summary;
  const commentsChanged = kept.length !== review.comments.length || kept.some((c, i) => keyOf(c) !== keyOf(review.comments[i]) || c.body !== review.comments[i].body);
  if (!summaryChanged && !commentsChanged) return null;
  return { type: "githubReview", ...(summaryChanged ? { summary: summary.trim() } : {}), ...(commentsChanged ? { comments: kept } : {}) };
}

/** What 'Discuss with Pip' asks about a review draft: read it and the pull request's comments, change it only when asked, and it stays a draft. */
export function reviewWithPipPrompt(p: Proposal): string {
  const r = p.intent as Review;
  const run = p.origin.type === "run" ? p.origin.runId : r.runId;
  return `Let's talk about the GitHub review draft ${p.id} of ${r.repo}#${r.number}, drafted from agent run ${run}. Read it in full with get_proposal and the pull request's existing comments with list_review_comments, then tell me what you would change. Revise the draft only if I ask you to; it stays a draft I post myself, so don't say anything has been posted.`;
}

/** What the card's Open PR view does: shows the pull request in Gossamr with this draft's comments in place. */
export const pullViewOf = (p: Proposal) => () => {
  const r = p.intent as Review;
  openPullView({ connectionId: r.connectionId, repo: r.repo, number: r.number, proposalId: p.id });
};

/** The lines of the diff around a comment, as a unified hunk with the comment's line marked. */
export function ReviewHunk({ file, line, side }: { file: ChangedFile | null | undefined; line: number; side: DiffSide }) {
  const around = file?.patch ? hunkLinesAround(file.patch, line, side) : null;
  if (!around) return <p className="m-0 text-xs text-ws-ink3">{file ? "The pull request's diff doesn't show this line now." : "This file isn't in the pull request's diff now."}</p>;
  return (
    <div data-review-hunk className="overflow-x-auto rounded border border-ws-sep bg-ws-bar py-0.5 font-mono text-xs leading-5">
      {around.lines.map((l, i) => {
        const target = i === around.at;
        return (
          <div
            key={i}
            data-hunk-line={l.kind}
            data-hunk-target={target ? "" : undefined}
            className={`flex whitespace-pre ${l.kind === "added" ? "bg-ws-done-soft" : l.kind === "deleted" ? "bg-ws-blocked-soft" : ""} ${target ? "font-semibold outline-1 outline-ws-pip outline-solid -outline-offset-1" : ""}`}
          >
            <span aria-hidden className="w-4 shrink-0 text-center text-ws-pip">
              {target ? "▸" : ""}
            </span>
            <span aria-hidden className="w-9 shrink-0 pr-1.5 text-right text-ws-ink3 select-none">
              {(side === "LEFT" ? l.left : l.right) ?? ""}
            </span>
            <span className="pr-2">{l.raw}</span>
          </div>
        );
      })}
    </div>
  );
}

/**
 * A GitHub review draft's card: its summary and each comment over the lines it is about, all editable, with comments
 * that can be dropped. Post review saves the person's edit first, then posts it as one comment review, and only when the
 * token may post; otherwise the card says why and shows the review in the in-app pull request view instead.
 */
export function ReviewDraft({ proposal: p, working, error, onApprove, onSkip, onOpenRun, onDiscuss, access = null, diff: given, initial }: DraftCardProps & { /** What a test shows instead of reading it. */ diff?: PullDiffState; /** The card as the person left it, for a test. */ initial?: { summary: string; comments: Held[] } }) {
  const review = p.intent as Review;
  const title = `GitHub review of ${review.repo}#${review.number}`;
  const [summary, setSummary] = useState(initial?.summary ?? review.summary);
  const [comments, setComments] = useState<Held[]>(() => initial?.comments ?? held(review));
  const edited = useRef(false);
  const attempting = useRef(working);
  attempting.current = working;
  /** The draft as the card last took it from the backend. */
  const base = useRef(review);
  /** The draft changed under the person's unsaved edit, which the card then merged in (`followDraft`). */
  const [followed, setFollowed] = useState(false);
  // Pip may revise the draft while the card is open, and a sent edit comes back from the backend: follow it, and once the
  // person has typed, merge it with what they typed rather than keep a list the draft no longer has.
  useEffect(() => {
    const was = base.current;
    base.current = review;
    if (takesBackendText(edited.current, attempting.current)) {
      edited.current = false;
      setFollowed(false);
      setSummary(review.summary);
      setComments(held(review));
      return;
    }
    if (was.summary === review.summary && JSON.stringify(was.comments) === JSON.stringify(review.comments)) return;
    const next = followDraft(was, review, summary, comments);
    setFollowed(true);
    setSummary(next.summary);
    setComments(next.comments);
  }, [review.summary, JSON.stringify(review.comments)]);
  const card = useRef<HTMLElement>(null);
  const hadFocus = useRef(false);
  // Decided in the peek, the card leaves "Drafts waiting"; the keyboard goes on to the next card, not nowhere.
  useLayoutEffect(() => {
    const el = card.current;
    return () => {
      const at = document.activeElement;
      if (!el || !hadFocus.current || !(!at || at === document.body || el.contains(at))) return;
      peekFocusAfterLeaving(el, document);
    };
  }, []);

  const read = usePullDiff(given ? null : review.connectionId, review.repo, review.number);
  const diff = given ?? read;
  const files = diff.status === "ready" ? diff.diff.files : null;
  const head = diff.status === "ready" ? diff.diff.change.sha : null;
  const state = p.state.type;
  const open = state === "pending" || state === "applying";
  const shownError = error ?? p.error;
  /** GitHub said the review's lines no longer match the pull request. */
  const outdated = p.error === REVIEW_OUTDATED_NOTE;
  const moved = open && !!head && !sameCommit(head, review.commitSha);
  const byPerson = p.revisions.some((r) => r.note === "Edited");
  const revision = p.revisions[p.revisions.length - 1];
  const edit = reviewEdit(review, summary, comments);
  const kept = comments.filter((c) => !c.dropped).map(({ path, line, side, body }) => ({ path, line, side, body }));
  const problem = edit ? reviewEditProblem(review, { summary, comments: kept }) : null;
  const canPost = !!access?.canPost;
  const pullView = pullViewOf(p);
  const change = (i: number, next: Partial<Held>) => {
    edited.current = true;
    setComments((was) => was.map((c, j) => (j === i ? { ...c, ...next } : c)));
  };

  return (
    <article
      ref={card}
      aria-label={title}
      data-draft={p.id}
      data-github-review
      onFocus={() => (hadFocus.current = true)}
      onBlur={(ev) => {
        if (ev.relatedTarget && !ev.currentTarget.contains(ev.relatedTarget as Node)) hadFocus.current = false;
      }}
      className={`ws-legacy overflow-clip rounded-[10px] border border-dashed border-ws-pip bg-ws-win text-base ${state === "skipped" || state === "retired" ? "opacity-55" : ""}`}
    >
      <div className="flex items-center gap-2 bg-ws-pip-soft px-3 py-1.5 text-sm font-semibold text-ws-pip">
        <span aria-hidden>✦</span>
        {title}
        <span className="ml-auto font-normal text-ws-ink3">{BADGE[state]}</span>
      </div>
      <div className="grid gap-2 px-3 py-2.5">
        <p className="m-0 flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm text-ws-ink2">
          <span className="font-mono font-semibold">
            {review.repo}#{review.number}
          </span>
          <span>
            reviewed at <span data-review-commit className="font-mono">{review.commitSha.slice(0, 8)}</span>
          </span>
          {byPerson && (
            <span data-review-edited className="rounded-full bg-ws-pip-soft px-2 text-xs font-semibold text-ws-pip">
              Edited
            </span>
          )}
          {outdated && (
            <span data-review-outdated className="rounded-full bg-ws-blocked-soft px-2 text-xs font-semibold text-ws-blocked">
              Outdated
            </span>
          )}
        </p>
        {p.origin.type === "run" && (
          <p data-provenance="run" className="m-0 text-sm text-ws-ink3">
            From agent run{" "}
            {onOpenRun ? (
              <button type="button" onClick={() => onOpenRun((p.origin as { runId: string }).runId)} className="font-mono font-semibold text-ws-pip hover:underline">
                {p.origin.shortId ?? "(no session id)"}
              </button>
            ) : (
              <b className="font-mono">{p.origin.shortId ?? "(no session id)"}</b>
            )}
            . Gossamr made it from the review&apos;s findings; read and edit it before you post.
          </p>
        )}
        {moved && (
          <p data-review-moved role="note" className="m-0 rounded-md border border-ws-sep2 bg-ws-bar px-2 py-1 text-sm text-ws-ink2">
            The pull request has moved on since this review: reviewed {review.commitSha.slice(0, 8)}, now at {head!.slice(0, 8)}. GitHub may mark these comments outdated.
          </p>
        )}
        <label className="grid gap-1 text-sm font-semibold" htmlFor={`review-summary-${p.id}`}>
          Review summary
          {open ? (
            <textarea
              id={`review-summary-${p.id}`}
              data-review-summary
              value={summary}
              disabled={working || state === "applying"}
              rows={Math.min(12, Math.max(3, summary.split("\n").length + 1))}
              onChange={(e) => {
                edited.current = true;
                setSummary(e.target.value);
              }}
              className="w-full resize-y rounded-md border border-ws-sep2 bg-ws-win px-2 py-1.5 text-base font-normal [overflow-wrap:anywhere]"
            />
          ) : (
            <span data-review-summary className="font-normal whitespace-pre-wrap [overflow-wrap:anywhere]">
              {review.summary}
            </span>
          )}
        </label>
        {comments.length > 0 && (
          <ul className="m-0 grid list-none gap-2 p-0">
            {comments.map((c, i) => {
              const place = placeOf(c);
              return (
                <li key={keyOf(c)} data-review-comment={c.dropped ? undefined : place} data-review-dropped={c.dropped ? place : undefined} className="grid gap-1 rounded-md border border-ws-sep2 px-2 py-1.5">
                  <span className="flex items-baseline gap-2">
                    <span className="min-w-0 font-mono text-sm font-semibold text-ws-ink2 [overflow-wrap:anywhere]">
                      {place}
                      {c.side === "LEFT" && <span className="font-sans font-normal text-ws-ink3"> (old side)</span>}
                    </span>
                    {open && (
                      <button type="button" disabled={working} aria-label={`${c.dropped ? "Restore" : "Drop"} comment on ${place}`} onClick={() => ((edited.current = true), setComments((was) => toggleDropped(was, i)))} className={`${button} ml-auto shrink-0 py-0.5 text-xs`}>
                        {c.dropped ? "Restore" : "Drop comment"}
                      </button>
                    )}
                  </span>
                  {c.dropped ? (
                    <p className="m-0 text-sm text-ws-ink3">Dropped: this comment won&apos;t be posted.</p>
                  ) : (
                    <>
                      {files ? <ReviewHunk file={files.find((f) => f.path === c.path)} line={c.line} side={c.side} /> : <p className="m-0 text-xs text-ws-ink3">{diff.status === "error" ? `Couldn't read the diff: ${diff.error}` : "Loading the diff…"}</p>}
                      {open ? (
                        <textarea
                          aria-label={`Comment on ${place}`}
                          value={c.body}
                          disabled={working || state === "applying"}
                          rows={Math.min(10, Math.max(2, c.body.split("\n").length + 1))}
                          onChange={(e) => change(i, { body: e.target.value })}
                          className="w-full resize-y rounded-md border border-ws-sep2 bg-ws-win px-2 py-1 text-base [overflow-wrap:anywhere]"
                        />
                      ) : (
                        <span className="whitespace-pre-wrap [overflow-wrap:anywhere]">{c.body}</span>
                      )}
                    </>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        <p className="m-0 text-sm text-ws-ink3">Posted as one comment review at the reviewed commit, never as an approval or a request for changes. Nothing goes to GitHub until you approve it here.</p>
        {open && access && !access.canPost && (
          <p data-review-access="cant-post" className="m-0 text-sm text-ws-ink2">
            {access.reason ?? "This GitHub token can't post reviews on this repository."}
          </p>
        )}
        {state === "applied" && p.posted && (
          <p data-review-posted className="m-0 text-sm text-ws-ink2">
            Posted to GitHub: <Link href={p.posted.url}>see the review on {review.repo}#{review.number}</Link>
          </p>
        )}
        {p.state.type === "retired" && <p className="m-0 text-sm text-ws-ink3">{p.state.reason}</p>}
        {open && revision && revision.note !== "Edited" && !shownError && <p data-review-revision className="m-0 text-sm text-ws-ink3">{revision.note}</p>}
        {open && followed && edit && (
          <p data-review-followed role="status" className="m-0 text-sm text-ws-ink2">
            This draft changed while you were editing it. Your words are kept on the comments it still has; nothing is saved until you post or discuss it.
          </p>
        )}
        {(shownError || problem) && (
          <p role="alert" className="m-0 text-sm text-ws-blocked">
            {shownError ?? problem}
          </p>
        )}
        <div className="sticky bottom-0 z-[1] -mx-3 -mb-2.5 flex flex-wrap items-center justify-end gap-2 border-t border-ws-sep bg-ws-win px-3 py-2">
          <button type="button" onClick={pullView} className={`${open && !canPost ? primary : button} ${open && !canPost ? "" : "mr-auto"}`}>
            Open PR view
          </button>
          {open && (
            <>
              {onDiscuss && (
                <button type="button" disabled={working || !!problem} title={problem ?? "Pip reads this review and the pull request's comments, and changes the draft if you ask. Your edit is saved first."} onClick={() => onDiscuss(edit)} className={button}>
                  Discuss with Pip
                </button>
              )}
              <button type="button" disabled={working} onClick={onSkip} className={button}>
                Discard
              </button>
              {canPost && (
                <button type="button" disabled={working || state === "applying" || !!problem} title={problem ?? undefined} onClick={() => onApprove(edit)} className={primary}>
                  {working || state === "applying" ? "Posting…" : "Post review"}
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </article>
  );
}
