import { docText } from "./docs";
import { maskSecrets } from "./riskyText";
import type { BasisField, Intent, ItemRef, Proposal, ReviewComment } from "../types";

/** Fails to compile when a switch over a union misses a case, and throws if one slips through at run time. */
export function unreachable(value: never): never {
  throw new Error(`Unhandled case: ${JSON.stringify(value)}`);
}

/** The existing item a draft is about; a new item has none yet. */
export function targetOf(intent: Intent): ItemRef | null {
  switch (intent.type) {
    case "comment":
    case "transition":
    case "update":
    case "rewrite":
      return intent.item;
    case "link":
      return intent.from;
    case "subtasks":
      return intent.parent;
    case "startRun":
    case "followUp":
    case "runAnswer":
    case "githubReview":
      return intent.item;
    case "create":
      return null;
    default:
      return unreachable(intent);
  }
}

/**
 * A few words of what a draft says, to name it in a line that has no card beside it (the Undo for a skip); masked, null for a draft
 * with no words of its own. `edited` is what the person typed into the card, which names it better than the stored text.
 */
export function draftExcerpt(intent: Intent, max = 40, edited?: { body?: { text: string } }): string | null {
  const text =
    intent.type === "comment" ? (edited?.body?.text ?? docText(intent.body))
    : intent.type === "create" ? intent.fields.title
    : "";
  const flat = maskSecrets(text).replace(/\s+/g, " ").trim();
  if (!flat) return null;
  return flat.length <= max ? flat : `${flat.slice(0, max).trimEnd()}…`;
}

/** What names a draft in a line with no card beside it: its excerpt, or for one with no words of its own what its card is titled ("Update the description of CA-401"); null when neither says more than the ticket. */
export function draftSaid(intent: Intent, edited?: { body?: { text: string } }): string | null {
  const said = draftExcerpt(intent, undefined, edited);
  if (said) return said;
  switch (intent.type) {
    case "rewrite":
      return `Update the ${intent.title && intent.body ? "title and description" : intent.body ? "description" : "title"} of ${intent.item.key}`;
    case "transition":
      return `Move ${intent.item.key}`;
    case "subtasks":
      return `Subtasks under ${intent.parent.key}`;
    case "update":
      return `Update ${intent.item.key}`;
    case "link":
      return `Link ${intent.from.key}`;
    default:
      return null;
  }
}

/** Whether a draft is sent to a run with a button of its own rather than applied with `proposalsApprove`. */
export const isRunDraft = (intent: Intent) => intent.type === "startRun" || intent.type === "followUp" || intent.type === "runAnswer";

/** Whether a draft is a review posted to GitHub with a button of its own, never applied with `proposalsApprove`. */
export const isReviewDraft = (intent: Intent) => intent.type === "githubReview";

/** The error a review draft keeps when GitHub said its lines no longer match the pull request, as `REVIEW_OUTDATED_NOTE` in `inbox/review_drafts.rs`. The card reads it as outdated. */
export const REVIEW_OUTDATED_NOTE = "GitHub says this review's lines no longer match the pull request; it is outdated. Discard it or edit the comments and try again.";

/** The error a review draft keeps when a post may have reached GitHub though no answer said so, as `REVIEW_MAYBE_POSTED_NOTE` in `inbox/review_drafts.rs`: the draft keeps `maybePosted`, and its next post looks on GitHub first. */
export const REVIEW_MAYBE_POSTED_NOTE = "GitHub may have posted this review already; Gossamr checks the pull request before sending it again.";

/** Why a review that may be on GitHub already isn't sent again once Gossamr looked and didn't find it, as `REVIEW_NOT_FOUND_NOTE` in `inbox/review_drafts.rs`: only Post anyway sends it. */
export const REVIEW_NOT_FOUND_NOTE = "Gossamr looked on the pull request and didn't find the review it may have posted. Check the pull request; if the review isn't there, choose Post anyway to send it.";

/** Why a review draft that changed since the person looked at it isn't posted, as `REVIEW_CHANGED` in `inbox/review_drafts.rs`. */
export const REVIEW_CHANGED = "this review changed since you looked at it; read it again before posting";

/** Why a person's edit of a review draft can't put a comment somewhere new, as `REVIEW_EDIT_KEEPS_POSITIONS` in `proposals.rs`. */
export const REVIEW_EDIT_KEEPS_POSITIONS = "an edit can't move a comment or add one at a new line; ask Pip to add it";

/** Why Pip can't revise a review draft the person edited, as `REVIEW_IS_THE_USERS` in `proposals.rs`. */
export const REVIEW_IS_THE_USERS = "the user edited this review draft, so Pip can't change it any more";

/** Why Pip can't put a review comment at `path:line`, as `Core::revise_review_as_pip` refuses it. */
export const offTheDiff = (path: string, line: number) => `${path}:${line} isn't a line the pull request's diff shows; call get_proposal to see the lines it has`;

type ReviewText = { summary: string; comments: ReviewComment[] };

/** What is wrong with the person's edit of a review draft, as `edit_noted` refuses it: they reword and drop, never move or add a comment, and nothing is left blank. */
export function reviewEditProblem(was: ReviewText, next: ReviewText): string | null {
  if (!next.summary.trim()) return "a review's summary can't be empty";
  if (next.comments.some((c) => !c.body.trim())) return "a review's comment can't be empty";
  const at = (c: ReviewComment) => `${c.path}\n${c.line}\n${c.side}`;
  const known = new Set(was.comments.map(at));
  if (next.comments.some((c) => !known.has(at(c)))) return REVIEW_EDIT_KEEPS_POSITIONS;
  if (new Set(next.comments.map(at)).size !== next.comments.length) return "there are two comments on one line; merge them into one";
  return null;
}

/** The drafts a screen that can only approve with `proposalsApprove` may offer: not the history of agent drafts, and a review is posted to GitHub with its own button. */
export function withoutRunDrafts(proposals: Proposal[]): Proposal[] {
  return proposals.filter((p) => !isRunDraft(p.intent) && !isReviewDraft(p.intent));
}

/** Drafts Pip made while answering one question, oldest first so they read in the order they were proposed. */
export function draftsForTurn(proposals: Proposal[], requestId: string): Proposal[] {
  return proposals
    .filter((p) => p.origin.type === "chat" && p.origin.requestId === requestId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** Open drafts on a ticket that no conversation on screen accounts for, such as ones made before a restart. */
export function earlierDrafts(proposals: Proposal[], ticketKey: string, requestIds: string[]): Proposal[] {
  return proposals
    .filter((p) => {
      const open = p.state.type === "pending" || p.state.type === "applying";
      const shown = p.origin.type === "chat" && requestIds.includes(p.origin.requestId);
      return open && !shown && targetOf(p.intent)?.key === ticketKey;
    })
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/**
 * The fields of a workstream's basis that writing `intent` changes, as `basis_fields`: a move its status, a rewrite its
 * summary and/or description. (An assignee change is no longer compared, so it isn't named here.)
 */
export function basisFieldsOf(intent: Intent): BasisField[] {
  if (intent.type === "transition") return ["status"];
  if (intent.type !== "rewrite") return [];
  return [...(intent.title ? (["summary"] as const) : []), ...(intent.body ? (["description"] as const) : [])];
}

/** The workstream a draft belongs to: the one it was made in, else the one a run it would start is linked to. */
export function workstreamOf(p: Proposal): string | null {
  const made = p.origin.type === "chat" || p.origin.type === "run" ? (p.origin.workstream ?? null) : null;
  return made ?? (p.intent.type === "startRun" ? (p.intent.spec.workstream ?? null) : null);
}

/**
 * Whether a workstream's conversation shows the draft: one of the workstream's own, or an open one on its ticket. Pip's
 * `[Workstream]` block lists the same open drafts, so the pane never hides one Pip is told about. A draft on its ticket
 * retired since the workstream opened (`createdAt`) stays too, collapsed with the reason, so it doesn't just vanish.
 */
export function inWorkstreamPane(p: Proposal, ws: { id: string; itemKey: string | null; connectionId: string; createdAt?: string }): boolean {
  if (workstreamOf(p) === ws.id) return true;
  const open = p.state.type === "pending" || p.state.type === "applying";
  const retiredSince = p.state.type === "retired" && !!ws.createdAt && p.updatedAt >= ws.createdAt;
  const target = targetOf(p.intent);
  return (open || retiredSince) && !!ws.itemKey && target?.key === ws.itemKey && target.connectionId === ws.connectionId;
}

export const REPLACED_REASON = "Replaced by a newer draft";
export const KEPT_EDITED = "draft_kept_edited";
export const KEPT_MAYBE_POSTED = "draft_kept_maybe_posted";
export const KEPT_PARTIAL = "draft_kept_partial";
export const KEPT_UNCONFIRMED = "draft_kept_unconfirmed";
export const PLAN_COMMENT_LABEL = "Plan from agent run";

export function supersessionKey(intent: Intent): string | null {
  const itemTarget = (item: ItemRef) => JSON.stringify([item.connectionId, item.externalId]);
  switch (intent.type) {
    case "comment":
    case "transition":
    case "rewrite":
    case "update":
      return intent.type + ":" + itemTarget(intent.item);
    case "subtasks":
      return "subtasks:" + itemTarget(intent.parent);
    case "create":
      return null;
    case "link":
      return "link:" + JSON.stringify([itemTarget(intent.from), itemTarget(intent.to)]);
    case "githubReview":
      return "githubReview:" + JSON.stringify([intent.connectionId, intent.repo.toLowerCase(), intent.number]);
    case "startRun":
    case "followUp":
    case "runAnswer":
      return null;
    default:
      return unreachable(intent);
  }
}

export type Supersession = { type: "unrelated" } | { type: "supersede" } | { type: "alongside"; reason: typeof KEPT_EDITED | typeof KEPT_MAYBE_POSTED | typeof KEPT_PARTIAL | typeof KEPT_UNCONFIRMED };

/** A refusal that says the write never started. The next draft of the same kind replaces it. Mirrors `attempt_unconfirmed` in `proposals.rs`. */
const wroteNothing = (error: string) => error.includes("nothing was written") || error.includes("can't change a ticket's title or description");

export function supersession(older: Proposal, newer: Proposal): Supersession {
  const key = supersessionKey(newer.intent);
  if (!key || older.id === newer.id || older.state.type !== "pending" || supersessionKey(older.intent) !== key) return { type: "unrelated" };
  if ((older.createdBy === "user" && older.origin.type !== "run") || older.revisions.some((revision) => revision.note === "Edited")) return { type: "alongside", reason: KEPT_EDITED };
  if (older.maybePosted) return { type: "alongside", reason: KEPT_MAYBE_POSTED };
  if (older.created.length > 0) return { type: "alongside", reason: KEPT_PARTIAL };
  if (older.error && !wroteNothing(older.error)) return { type: "alongside", reason: KEPT_UNCONFIRMED };
  return { type: "supersede" };
}

export function keptOlderReviews(proposal: Proposal, all: readonly Proposal[]): { proposal: Proposal; why: typeof KEPT_EDITED | typeof KEPT_MAYBE_POSTED | typeof KEPT_UNCONFIRMED }[] {
  if (proposal.intent.type !== "githubReview") return [];
  return all.flatMap((older) => {
    if (older.createdAt > proposal.createdAt) return [];
    const verdict = supersession(older, proposal);
    return verdict.type === "alongside" && verdict.reason !== KEPT_PARTIAL ? [{ proposal: older, why: verdict.reason }] : [];
  });
}

/** Whether an agent run left this draft for the person. Drafts stored before `agent` existed say `user`. */
export function leftByRun(p: Proposal): boolean {
  return p.origin.type === "run" && (p.createdBy === "agent" || p.createdBy === "user");
}
