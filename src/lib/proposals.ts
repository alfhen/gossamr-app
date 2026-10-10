import type { BasisField, Intent, ItemRef, Proposal, ProposalMaker, ReviewComment } from "../types";

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

/** The drafts a screen that can only approve with `proposalsApprove` may offer: a run is approved with `runsApprove` after its prompt is shown, a follow-up with `runsSendFollowUp`, an answer with `runsAnswerDraft`, and a review is posted to GitHub with its own button. */
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

/** The most drafts a workstream holds waiting for the person before Pip is told to stop drafting, as `WORKSTREAM_PENDING_CAP` in `proposals.rs`. */
export const WORKSTREAM_PENDING_CAP = 8;

/** Why a draft a newer one of the same kind replaced was retired, as `REPLACED_REASON` in `proposals.rs`. */
export const REPLACED_REASON = "Replaced by a newer draft";

/**
 * What a newer draft of the same kind replaces in a workstream: one move, one description update, one triage update and
 * one breakdown per ticket, one answer per run, and one review per pull request. Comments accumulate, and the other kinds have rules of their own. As
 * `Intent::supersession_key`.
 */
export function supersessionKey(intent: Intent): string | null {
  switch (intent.type) {
    case "transition":
    case "rewrite":
    case "update":
      return `${intent.type}:${intent.item.externalId}`;
    case "subtasks":
      return `subtasks:${intent.parent.externalId}`;
    case "runAnswer":
      return `runAnswer:${intent.runId}`;
    case "githubReview":
      return `githubReview:${intent.repo.toLowerCase()}#${intent.number}`;
    case "comment":
    case "create":
    case "link":
    case "startRun":
    case "followUp":
      return null;
    default:
      return unreachable(intent);
  }
}

/**
 * Whether `newer` changes every field `older`, of the same kind and key, changes, so nothing is lost when it replaces it:
 * a triage update sets the assignee, epic and priority apart, and a rewrite the title and description apart. As
 * `Intent::covers`.
 */
export function covers(newer: Intent, older: Intent): boolean {
  if (newer.type === "update" && older.type === "update") {
    const [n, o] = [newer.patch, older.patch];
    return (o.assignee == null || n.assignee != null) && (o.parent == null || n.parent != null) && (o.priority == null || n.priority != null);
  }
  if (newer.type === "rewrite" && older.type === "rewrite") return (older.title == null || newer.title != null) && (older.body == null || newer.body != null);
  return true;
}

/** What a new draft does to an older one in its workstream, as `Supersession` in `proposals.rs`; `refuse` carries the reason. */
export type Supersession = { type: "unrelated" } | { type: "supersede" } | { type: "alongside" } | { type: "refuse"; reason: string };

/** The plan a build follows; only the person changes it. The same words as `proposals.rs`. */
export const PLAN_IS_THE_USERS = "this description update carries the Gossamr Plan a build follows, so only the user changes it; tell them what you would change instead";

/** Whether Pip or an agent run made the draft rather than a person; run drafts stored before `agent` existed say `user`. */
const machineMade = (p: Proposal) => p.createdBy === "pip" || p.createdBy === "agent" || (p.createdBy === "user" && p.origin.type === "run");

/**
 * Whether `newer` replaces `older`: a pending draft of the same kind on the same ticket in the same workstream, both made
 * by Pip or an agent, that changes every field the older one does (`covers`). A draft the person edited is theirs, and the plan a build follows (`isPlanRewrite`) only the person
 * changes. As `supersession` in `proposals.rs`.
 */
export function supersession(older: Proposal, newer: Proposal, isPlanRewrite: (p: Proposal) => boolean): Supersession {
  const ws = workstreamOf(newer);
  const key = supersessionKey(newer.intent);
  if (!ws || !key || older.state.type !== "pending" || workstreamOf(older) !== ws || !machineMade(older) || !machineMade(newer)) return { type: "unrelated" };
  // A newer draft that leaves a field of the older one alone would lose that change, so both stay.
  if (supersessionKey(older.intent) !== key || !covers(newer.intent, older.intent)) return { type: "unrelated" };
  const byPip = newer.createdBy === "pip";
  if (older.revisions.some((r) => r.note === "Edited")) {
    const on = targetOf(older.intent);
    return byPip ? { type: "refuse", reason: `the user edited draft ${older.id} of the same kind${on ? ` on ${on.key}` : ""}, so it stays theirs; leave it to them rather than drafting another` } : { type: "alongside" };
  }
  if (byPip && isPlanRewrite(older)) return { type: "refuse", reason: PLAN_IS_THE_USERS };
  return { type: "supersede" };
}

/** What Pip is told when a workstream already holds its share of drafts, as in `proposals.rs`. */
export const capRefusal = (workstream: string) =>
  `Workstream ${workstream} already has ${WORKSTREAM_PENDING_CAP} drafts waiting for the user. Don't draft more until they decide some; revise one with revise_proposal or withdraw one with retire_proposal.`;

/** Whether an agent run left this draft for the person. Drafts stored before `agent` existed say `user`. */
export function leftByRun(p: Proposal): boolean {
  return p.origin.type === "run" && (p.createdBy === "agent" || p.createdBy === "user");
}

/** Who made a draft, as a short phrase. */
export function makerName(by: ProposalMaker): string {
  switch (by) {
    case "user":
      return "You";
    case "pip":
      return "Pip";
    case "autopilot":
      return "Autopilot";
    case "agent":
      return "An agent run";
    default:
      return unreachable(by);
  }
}
