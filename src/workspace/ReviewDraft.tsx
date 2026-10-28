import { useEffect, useLayoutEffect, useRef, useState, type TextareaHTMLAttributes } from "react";
import { Link } from "../components/Adf";
import { Markdown } from "../components/Markdown";
import { useAutoHeight } from "../components/autoHeight";
import { parseBlocks, plainMarkdown } from "../lib/markdown";
import { hunkLinesAround } from "../lib/diffHunks";
import { KEPT_EDITED, keptOlderReviews, REVIEW_OUTDATED_NOTE, reviewEditProblem } from "../lib/proposals";
import { maskSecrets, newRiskQuote, newRisks, type Risk, type RiskQuotes } from "../lib/riskyText";
import { PostingPause } from "./PostingPause";
import type { ChangedFile, DiffSide, Proposal, ProposalEdit, ReviewComment } from "../types";
import { showPause, type DraftCardProps } from "./DraftCard";
import { useCardKeys } from "./draftCardKeys";
import { PEEK_DRAFT_MARGIN, peekFocusAfterLeaving } from "./peekDrafts";
import { sameCommit, usePullDiff, type PullDiffState } from "./reviewDiff";
import { openOnGithub } from "./githubUi";
import { takesBackendText } from "./RewriteDiff";
import { FromRun } from "./RunProvenance";
import { useWorkspace } from "../workspaceStore";

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

/**
 * What the person's edit of a review adds that would reach everyone or leak a secret: the summary and each kept comment are
 * checked against what the draft said (`newRisks`, the rules the other drafts' pause uses). A comment that is dropped isn't posted, so it isn't checked.
 */
export function reviewRisks(review: Review, summary: string, comments: readonly Held[]): { risks: Risk[]; quote: RiskQuotes } {
  const was = new Map(review.comments.map((c) => [keyOf(c), c.body]));
  const pairs = [{ was: review.summary, now: summary }, ...comments.filter((c) => !c.dropped).map((c) => ({ was: was.get(keyOf(c)) ?? "", now: c.body }))];
  const risks = new Set<Risk>();
  const quote: RiskQuotes = {};
  for (const { was: before, now } of pairs) {
    for (const r of newRisks(before, now)) risks.add(r);
    for (const [r, found] of Object.entries(newRiskQuote(before, now)) as [Risk, string[]][]) quote[r] = [...new Set([...(quote[r] ?? []), ...found])];
  }
  return { risks: (["broadcast", "secret"] as const).filter((r) => risks.has(r)), quote };
}

/** What 'Ask Pip' asks about a review draft: read it and the pull request's comments, change it only when asked, and it stays a draft. */
export function reviewWithPipPrompt(p: Proposal): string {
  const r = p.intent as Review;
  const run = p.origin.type === "run" ? p.origin.runId : r.runId;
  return `Let's talk about the GitHub review draft ${p.id} of ${r.repo}#${r.number}, drafted from agent run ${run}. Read it in full with get_proposal and the pull request's existing comments with list_review_comments, then tell me what you would change. Revise the draft only if I ask you to; it stays a draft I post myself, so don't say anything has been posted.`;
}

/** What Post review sends, said beside it: how many inline comments, and that it is a comment review, never a verdict. */
export function postsWhat(comments: number): string {
  const inline = comments > 0 ? `${comments} inline comment${comments === 1 ? "" : "s"} and ` : "";
  return `Posts ${inline}the summary as a comment review (not Approve or Request changes), at the reviewed commit.`;
}

/**
 * The end of a decided review's provenance line, in place of the before-you-post advice: where and at which commit it went
 * once posted ("Posted to acme/webshop#218 at a1b2c3d4."), or that it was discarded or replaced.
 */
export function postedLine(state: Proposal["state"]["type"], r: Pick<Review, "repo" | "number" | "commitSha">): string {
  if (state === "applied") return `. Posted to ${r.repo}#${r.number} at ${r.commitSha.slice(0, 8)}, as a comment review.`;
  if (state === "skipped") return ". Discarded: nothing went to GitHub.";
  return ".";
}

/** The Post review button's label: with how many inline comments go out, so the bar says what it sends. */
export const postLabel = (comments: number): string => (comments > 0 ? `Post review (${comments} comment${comments === 1 ? "" : "s"})` : "Post review");

/** What a posted review went out with, near the top of its card; null when it had no inline comments. */
export const postedWith = (comments: number): string | null => (comments > 0 ? `Posted with ${comments} comment${comments === 1 ? "" : "s"}` : null);

/** Under the review's text boxes: what GitHub does with their words. */
export const MARKDOWN_HINT = "Markdown, formatted on GitHub";

/**
 * What the card says of an older review of the same pull request that this one left standing, as `keptOlderReviews`
 * finds it: the person edited it, or GitHub may have it already. Null when there is none.
 */
export function keptOlderNote(p: Proposal, all: readonly Proposal[]): string | null {
  const kept = keptOlderReviews(p, all);
  if (!kept.length) return null;
  const number = (p.intent as Review).number;
  return kept.some((k) => k.why === KEPT_EDITED)
    ? `An older review of #${number} that you edited is still waiting; this one didn't replace it.`
    : `An older review of #${number} that may already be on GitHub is still waiting; this one didn't replace it.`;
}

/** Whether `text` has anything Markdown would change on GitHub: a marker, a list, a heading, code, a table or a break. */
export const hasMarkdown = (text: string): boolean => {
  const blocks = parseBlocks(text);
  return blocks.length > 1 || blocks.some((b) => b.type !== "paragraph") || plainMarkdown(text) !== text;
};

/** What GitHub will show for a text box's words, read-only under it. Nothing for words that have no Markdown in them. */
export function ReviewPreview({ text, label }: { text: string; label: string }) {
  if (!hasMarkdown(text)) return null;
  return (
    <div role="group" aria-label={`Preview of ${label}`} data-review-preview className="rounded-md border border-ws-sep2 bg-ws-bar px-2 py-1.5 text-sm font-normal">
      <Markdown text={text} />
    </div>
  );
}

/** A review's text box, as tall as its words, so a long comment never hides behind a scroll of its own. */
function GrowingText(props: TextareaHTMLAttributes<HTMLTextAreaElement> & { value: string }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useAutoHeight(ref, props.value);
  return <textarea ref={ref} {...props} />;
}

/**
 * The lines of the diff around a comment, as a unified hunk with the comment's line marked: two either side, so the first
 * comment's box is in view under the summary in the peek's default width, above the action bar.
 */
export function ReviewHunk({ file, line, side, context = 2 }: { file: ChangedFile | null | undefined; line: number; side: DiffSide; context?: number }) {
  const around = file?.patch ? hunkLinesAround(file.patch, line, side, context) : null;
  if (!around) return <p className="m-0 text-xs text-ws-ink3">{file ? "The pull request's diff doesn't show this line now." : "This file isn't in the pull request's diff now."}</p>;
  return (
    <div data-review-hunk className="rounded border border-ws-sep bg-ws-bar py-0.5 font-mono text-xs leading-5">
      {around.lines.map((l, i) => {
        const target = i === around.at;
        return (
          <div
            key={i}
            data-hunk-line={l.kind}
            data-hunk-target={target ? "" : undefined}
            className={`flex ${l.kind === "added" ? "bg-ws-done-soft" : l.kind === "deleted" ? "bg-ws-blocked-soft" : ""} ${target ? "font-semibold outline-1 outline-ws-pip outline-solid -outline-offset-1" : ""}`}
          >
            <span aria-hidden className="w-4 shrink-0 text-center text-ws-pip">
              {target ? "▸" : ""}
            </span>
            <span aria-hidden className="w-9 shrink-0 pr-1.5 text-right text-ws-ink3 select-none">
              {(side === "LEFT" ? l.left : l.right) ?? ""}
            </span>
            {/* A long line wraps rather than run off the card's edge. */}
            <span className="min-w-0 pr-2 whitespace-pre-wrap [overflow-wrap:anywhere]">{l.raw}</span>
          </div>
        );
      })}
    </div>
  );
}

/**
 * A GitHub review draft's card: its summary and each comment over the lines it is about, all editable, with comments
 * that can be dropped. Post review saves the person's edit first, then posts it as one comment review, and only when the
 * token may post; otherwise the card says why and offers to open the pull request on GitHub instead.
 */
export function ReviewDraft({
  proposal: p,
  working,
  error,
  onApprove,
  onSkip,
  onOpenRun,
  onDiscuss,
  access = null,
  diff: given,
  initial,
  drafts: givenDrafts,
}: DraftCardProps & {
  /** What a test shows instead of reading it. */ diff?: PullDiffState;
  /** The card as the person left it, for a test. */ initial?: { summary: string; comments: Held[] };
  /** The drafts there are, for a test; otherwise read from the workspace. */ drafts?: readonly Proposal[];
}) {
  const review = p.intent as Review;
  const stored = useWorkspace((s) => s.proposals);
  const olderKept = p.state.type === "pending" ? keptOlderNote(p, givenDrafts ?? Object.values(stored)) : null;
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
  // Read-only text is shown masked, as every Jira surface does; the editable boxes keep the text as it is.
  const shownSummary = maskSecrets(review.summary);
  const shownBodies = comments.map((c) => maskSecrets(c.body));
  const masked = !open && (shownSummary !== review.summary || comments.some((c, i) => !c.dropped && shownBodies[i] !== c.body));
  /** GitHub said the review's lines no longer match the pull request. */
  const outdated = p.error === REVIEW_OUTDATED_NOTE;
  const moved = open && !!head && !sameCommit(head, review.commitSha);
  const byPerson = p.revisions.some((r) => r.note === "Edited");
  const revision = p.revisions[p.revisions.length - 1];
  const edit = reviewEdit(review, summary, comments);
  const kept = comments.filter((c) => !c.dropped).map(({ path, line, side, body }) => ({ path, line, side, body }));
  const problem = edit ? reviewEditProblem(review, { summary, comments: kept }) : null;
  const canPost = !!access?.canPost;
  const hint = `review-markdown-${p.id}`;
  // Edited words that mention everyone or look like a secret wait for a second press, as on the other drafts: a confirm the person can pass, never a block.
  const [pause, setPause] = useState<{ risks: Risk[]; quote: RiskQuotes } | null>(null);
  /** The step Post review, Post anyway and Enter take: pauses once for edited text that would reach everyone, else approves. */
  const post = (opts?: { postAnyway?: boolean }) => {
    const found = reviewRisks(review, summary, comments);
    if (found.risks.length && !pause) {
      setPause(found);
      // The keyboard goes to the safe choice, not to a Post button that now reads "Post it anyway".
      requestAnimationFrame(() => showPause(card.current));
      return;
    }
    setPause(null);
    onApprove(edit, opts);
  };
  /** Keep editing: the pause goes, the text stays and the summary has the keyboard. */
  const keepEditing = () => {
    setPause(null);
    requestAnimationFrame(() => card.current?.querySelector<HTMLElement>("textarea")?.focus());
  };
  // Another edit takes the pause back: it said what the earlier words held.
  useEffect(() => setPause(null), [summary, JSON.stringify(comments)]);
  const approvable = open && !working && state !== "applying" && !problem;
  const keys = useCardKeys(p, {
    // Posting by key is the Post review button's step, asked for Enter first, and only where the token can post.
    approve: canPost && approvable ? () => post() : undefined,
    skip: open && !working ? onSkip : undefined,
    edit: open ? () => requestAnimationFrame(() => card.current?.querySelector<HTMLElement>("textarea")?.focus()) : undefined,
    open: open ? () => requestAnimationFrame(() => (card.current?.querySelector<HTMLElement>('[aria-label^="Comment on "]') ?? card.current?.querySelector<HTMLElement>("textarea"))?.focus()) : undefined,
    openHint: "edit review",
    canApprove: canPost,
  });
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
      {...keys.props}
      onFocus={(ev) => {
        hadFocus.current = true;
        keys.props.onFocus(ev);
      }}
      onBlur={(ev) => {
        if (ev.relatedTarget && !ev.currentTarget.contains(ev.relatedTarget as Node)) hadFocus.current = false;
        keys.props.onBlur(ev);
      }}
      className={`ws-legacy ${PEEK_DRAFT_MARGIN} overflow-clip rounded-[10px] border border-dashed border-ws-pip bg-ws-win text-base focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ws-pip ${state === "skipped" || state === "retired" ? "opacity-55" : ""}`}
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
          {state === "applied" && postedWith(review.comments.length) && (
            <span data-review-posted-with className="font-semibold text-ws-done">
              {postedWith(review.comments.length)}
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
            <FromRun proposal={p} onOpen={onOpenRun ? () => onOpenRun((p.origin as { runId: string }).runId) : undefined} />
            {open ? ". Gossamr made it from the review's findings; read and edit it before you post." : postedLine(state, review)}
          </p>
        )}
        {olderKept && (
          <p data-review-kept-older role="note" className="m-0 rounded-md border border-ws-sep2 bg-ws-bar px-2 py-1 text-sm text-ws-ink2">
            {olderKept}
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
            <GrowingText
              id={`review-summary-${p.id}`}
              aria-describedby={hint}
              data-review-summary
              value={summary}
              disabled={working || state === "applying"}
              rows={Math.min(12, Math.max(3, summary.split("\n").length + 1))}
              onChange={(e) => {
                edited.current = true;
                setSummary(e.target.value);
              }}
              className="w-full scroll-mb-16 resize-none rounded-md border border-ws-sep2 bg-ws-win px-2 py-1.5 text-base font-normal [overflow-wrap:anywhere]"
            />
          ) : (
            <div data-review-summary className="font-normal [overflow-wrap:anywhere]">
              <Markdown text={shownSummary} />
            </div>
          )}
        </label>
        {open && <ReviewPreview text={summary} label="the review summary" />}
        {comments.length > 0 && (
          <ul className="m-0 grid list-none gap-2 p-0">
            {comments.map((c, i) => {
              const place = placeOf(c);
              return (
                <li key={keyOf(c)} data-review-comment={c.dropped ? undefined : place} data-review-dropped={c.dropped ? place : undefined} className="grid scroll-mb-16 gap-1 rounded-md border border-ws-sep2 px-2 py-1.5">
                  <span className="flex items-baseline gap-2">
                    <span className="min-w-0 font-mono text-sm font-semibold text-ws-ink2 [overflow-wrap:anywhere]">
                      {place}
                      {c.side === "LEFT" && <span className="font-sans font-normal text-ws-ink3"> (old side)</span>}
                    </span>
                    {open && (
                      <button type="button" disabled={working} aria-label={`${c.dropped ? "Restore" : "Drop"} comment on ${place}`} onClick={() => (edited.current = true, setComments((was) => toggleDropped(was, i)))} className={`${button} ml-auto shrink-0 py-0.5 text-xs`}>
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
                        <GrowingText
                          aria-label={`Comment on ${place}`}
                          aria-describedby={hint}
                          value={c.body}
                          disabled={working || state === "applying"}
                          rows={Math.min(10, Math.max(2, c.body.split("\n").length + 1))}
                          onChange={(e) => change(i, { body: e.target.value })}
                          className="w-full scroll-mb-16 resize-none rounded-md border border-ws-sep2 bg-ws-win px-2 py-1 text-base [overflow-wrap:anywhere]"
                        />
                      ) : (
                        <div className="[overflow-wrap:anywhere]">
                          <Markdown text={shownBodies[i]} />
                        </div>
                      )}
                      {open && <ReviewPreview text={c.body} label={`the comment on ${place}`} />}
                    </>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {masked && (
          <p data-review-masked className="m-0 text-xs text-ws-ink3">
            Part of this looked like a password, key or token and is hidden here. GitHub holds the text as it was posted.
          </p>
        )}
        {open && (
          <p id={hint} data-review-markdown className="m-0 text-xs text-ws-ink3">
            {MARKDOWN_HINT}
          </p>
        )}
        {open && (
          <p data-review-posts className="m-0 text-sm text-ws-ink3">
            {postsWhat(kept.length)} Nothing goes to GitHub until you post it here.
          </p>
        )}
        {open && p.maybePosted && (
          <p data-review-maybe-posted role="note" className="m-0 rounded-md border border-ws-sep2 bg-ws-bar px-2 py-1 text-sm text-ws-ink2">
            This review may already be on GitHub: Gossamr sent it at {p.maybePosted.commitSha.slice(0, 8)} and got no answer. Post review looks for it on the pull request first and sends nothing while it can&apos;t be sure.
            {p.maybePosted.checkedAt && canPost && " If it isn't there, Post anyway sends it."}
          </p>
        )}
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
        {pause && open && <PostingPause risks={pause.risks} quote={pause.quote} where="the pull request" subject="Your edit" anyway="Post it anyway" working={working || state === "applying" || !!problem} onKeep={keepEditing} onPost={() => post()} />}
        <div data-draft-actions className="sticky bottom-0 z-[1] -mx-3 -mb-2.5 flex flex-wrap items-center justify-end gap-2 border-t border-ws-sep bg-ws-win px-3 py-2">
          <button type="button" onClick={() => void openOnGithub(`https://github.com/${review.repo}/pull/${review.number}`)} className={`${button} mr-auto`}>Open on GitHub</button>
          {open && (
            <>
              <button type="button" data-draft-edit disabled={working} onClick={() => card.current?.querySelector<HTMLTextAreaElement>("textarea")?.focus()} className={button}>Edit</button>
              {onDiscuss && (
                <button type="button" disabled={working || !!problem} title={problem ?? "Pip reads this review and the pull request's comments, and changes the draft if you ask. Your edit is saved first."} onClick={() => onDiscuss(edit)} className={button}>
                  Discuss with Pip
                </button>
              )}
              <button type="button" disabled={working} onClick={onSkip} className={button}>
                Skip
              </button>
              {canPost && p.maybePosted?.checkedAt && (
                <button type="button" data-review-post-anyway disabled={working || state === "applying" || !!problem} title={problem ?? "Sends this review though it may already be on GitHub."} onClick={() => post({ postAnyway: true })} className={button}>
                  Post again
                </button>
              )}
              {/* While the pause shows, its own Post it anyway stands in for this button, beside Keep editing. */}
              {canPost && !pause && (
                <button type="button" disabled={working || state === "applying" || !!problem} title={problem ?? undefined} onClick={() => post()} className={primary}>
                  {working || state === "applying" ? "Posting…" : "Approve"}
                </button>
              )}
            </>
          )}
        </div>
      </div>
      {keys.hint && (
        <p role="status" data-key-hint className={`m-0 border-t border-ws-sep px-3 py-1 text-xs ${keys.asking ? "bg-ws-pip-soft font-semibold text-ws-pip" : "bg-ws-bar text-ws-ink3"}`}>
          {keys.hint}
        </p>
      )}
    </article>
  );
}
