import { docText } from "./docs";
import { maskSecrets } from "./riskyText";
import type { BasisField, Intent, ItemRef, Proposal, ProposalMaker, ReviewComment, RunKind } from "../types";

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

/** The audit line an older review draft of the same pull request gets when a newer review leaves it standing because the person edited it, as `KEPT_EDITED` in `proposals.rs`. */
export const KEPT_EDITED = "draft_kept_edited";
/** The same when GitHub may already have the older one, as `KEPT_MAYBE_POSTED`. */
export const KEPT_MAYBE_POSTED = "draft_kept_maybe_posted";

/** Whether `p` is a review draft an agent run left, which is tidied by its pull request rather than its workstream (`tidy_reviews`). */
export const isRunReview = (p: Proposal) => p.createdBy === "agent" && p.origin.type === "run" && p.intent.type === "githubReview";

/**
 * What a new review of a pull request does to an older pending review draft, as `review_supersession` in `proposals.rs`:
 * the person's edit and a post that may be on GitHub keep it (the audit line says which); anything else made by Pip or
 * an agent is replaced. Null when it isn't a review draft of the same pull request on the same code host, or isn't
 * pending (one being posted, or posted, is never touched).
 */
export function reviewSupersession(older: Proposal, newer: Proposal): "supersede" | typeof KEPT_EDITED | typeof KEPT_MAYBE_POSTED | null {
  if (newer.intent.type !== "githubReview" || older.intent.type !== "githubReview") return null;
  const same = older.intent.connectionId === newer.intent.connectionId && supersessionKey(older.intent) === supersessionKey(newer.intent);
  if (!same || older.id === newer.id || older.state.type !== "pending" || !machineMade(older)) return null;
  if (older.revisions.some((r) => r.note === "Edited")) return KEPT_EDITED;
  if (older.maybePosted) return KEPT_MAYBE_POSTED;
  return "supersede";
}

/** The label of a comment draft that carries a plan run's whole plan, which no later comment replaces. As `PLAN_COMMENT_LABEL` in `proposals.rs`. */
export const PLAN_COMMENT_LABEL = "Plan from agent run";

/** The label of a comment draft that asks a ticket's reporter the questions a triage left open, which no run's comment replaces and which replaces none. As `READINESS_COMMENT_LABEL` in `proposals.rs`. */
export const READINESS_COMMENT_LABEL = "Questions for the reporter";

/** Whether `p` is the comment "Ask the reporter" (or "Ask the reporter now") drafted: Gossamr's words around the open questions, never one Pip made, whatever it is labelled. As `is_reporter_questions`. */
export const isReporterQuestions = (p: Proposal) => p.intent.type === "comment" && p.label === READINESS_COMMENT_LABEL && p.createdBy !== "pip";

/** What the second ask to a reporter says in place of the first's frame, once they have answered: the mark of a follow-up. As `reporter_comment` in `workstreams.rs`. */
export const FOLLOW_UP_MARK = "Thanks for your answer above.";

/** Whether `p` is a reporter's questions asked again after a reply (`isReporterQuestions`, worded as the follow-up). */
export const isReporterFollowUp = (p: Proposal) => isReporterQuestions(p) && p.intent.type === "comment" && docText(p.intent.body).includes(FOLLOW_UP_MARK);

/** The label of the follow-up comment "Draft a nudge" drafts when the reporter has been silent for days: short and polite, never in the safe batch. As `NUDGE_COMMENT_LABEL` in `proposals.rs`. */
export const NUDGE_COMMENT_LABEL = "Nudge for the reporter";

/** Whether `p` is the comment "Draft a nudge" drafted: Gossamr's words, never one Pip made, whatever it is labelled. As `is_reporter_nudge`. */
export const isReporterNudge = (p: Proposal) => p.intent.type === "comment" && p.label === NUDGE_COMMENT_LABEL && p.createdBy !== "pip";

/** The label of a comment Pip drafts once the person chose "I'll answer" on a triage's open questions: each question with their answer, for the ticket. As `ANSWERS_COMMENT_LABEL` in `proposals.rs`. */
export const ANSWERS_COMMENT_LABEL = "Answers to the open questions";
/** The first line of that comment, so a Jira reader knows the open questions on the ticket are answered below. Neutral voice; as `ANSWERS_OPENING` in `proposals.rs`. */
export const ANSWERS_OPENING = "Answers to the open questions on this ticket:";

/** Whether `p` is the comment Pip drafted with the person's answers to the open questions. As `is_answers_draft`. */
export const isAnswersDraft = (p: Proposal) => p.intent.type === "comment" && p.label === ANSWERS_COMMENT_LABEL && p.createdBy === "pip";

/** How much of the reply the provenance line quotes. */
const REPLY_QUOTED = 80;

/** Whether an answers comment's text puts an "Answer:" under every question it quotes (numbered or not), rather than quoting them and answering once. */
export function answersPaired(body: string): boolean {
  const lines = body.split("\n").map((l) => l.trim());
  const questions = lines.filter((l) => /^(?:\d+[.)]\s+)?\u201c/.test(l)).length;
  return questions > 0 && lines.filter((l) => /^Answer:/i.test(l)).length === questions;
}

/** Whether an answers comment's text quotes any question at all (a reply typed afresh, with no questions to pair, quotes none). */
const answersQuote = (body: string): boolean => body.split("\n").some((l) => /^(?:\d+[.)]\s+)?\u201c/.test(l.trim()));

/**
 * The line under the answers draft's card that says which reply it was made from: the start of what the person wrote after "My answers:"
 * in the message `prompt` (null when that turn is no longer at hand, then the line names the reply without quoting it). Shown in the app
 * only; the comment that goes to Jira has none of it. Given the comment's text (`body`), it says "each answer under its question" only when
 * the text does that (`answersPaired`); otherwise the questions and then the answers as written.
 */
export function answersProvenance(prompt: string | null, body?: string): string {
  const at = prompt?.indexOf("My answers:") ?? -1;
  // A secret the person pasted is masked before the cut, so the line never shows it and the cut counts what is shown.
  const reply = maskSecrets((at >= 0 ? prompt!.slice(at + "My answers:".length) : (prompt ?? "")).replace(/\s+/g, " ").trim());
  const quoted = reply ? ` “${[...reply].length > REPLY_QUOTED ? `${[...reply].slice(0, REPLY_QUOTED).join("").trimEnd()}…` : reply}”` : "";
  return `Drafted from your reply${quoted} in this conversation, ${body === undefined || answersPaired(body) ? "each answer under its question" : answersQuote(body) ? "the questions, then your answers as written" : "your answers as written"}. Read and edit it before you approve.`;
}

/**
 * What the questions to a reporter made from a triage do to an older pending draft: the triage's own comment, which repeats
 * them, is replaced, so "Approve N safe drafts" can't post both; the person's edit keeps it. Null when `older` is none of
 * that. As `tidy_reporter_questions`.
 */
export function reporterSupersession(older: Proposal, newer: Proposal): "supersede" | typeof KEPT_EDITED | null {
  if (!isReporterQuestions(newer) || newer.origin.type !== "run" || older.origin.type !== "run") return null;
  const [on, to] = [targetOf(older.intent), targetOf(newer.intent)];
  const same = isRunComment(older) && older.id !== newer.id && older.origin.runId === newer.origin.runId && workstreamOf(older) === workstreamOf(newer) && !!on && !!to && on.connectionId === to.connectionId && on.externalId === to.externalId;
  if (!same || older.state.type !== "pending" || older.error) return null;
  return older.revisions.some((r) => r.note === "Edited") ? KEPT_EDITED : "supersede";
}

/** Why a Triage's own pending comment was retired once the person chose "I'll answer", as `ANSWERED_REASON` in `proposals.rs`. */
export const ANSWERED_REASON = "Replaced by your answers to the open questions";

/** Why it was retired once the person chose "Plan anyway", as `OVERRIDDEN_REASON` in `proposals.rs`. */
export const OVERRIDDEN_REASON = "You chose to plan anyway, so this note no longer fits";

/**
 * What the comment with the person's answers does to an older pending comment: the Triage's own note, which says the
 * ticket can't be sized, is replaced, and the person's edit keeps it. Another run kind's comment (an Investigate's findings)
 * is never touched. Null when `older` is not that: another ticket or workstream, not pending, or back in Pending after a
 * failed post (`error` is set). As `answers_supersession` in `proposals.rs`.
 */
export function answersSupersession(older: Proposal, newer: Proposal, kindOf: (runId: string) => RunKind | null): "supersede" | typeof KEPT_EDITED | null {
  const ws = workstreamOf(newer);
  if (!ws || !isAnswersDraft(newer) || !isRunComment(older) || workstreamOf(older) !== ws || older.id === newer.id || older.state.type !== "pending" || older.error) return null;
  const [on, to] = [targetOf(older.intent), targetOf(newer.intent)];
  if (!on || !to || on.connectionId !== to.connectionId || on.externalId !== to.externalId || older.origin.type !== "run") return null;
  if (kindOf(older.origin.runId) !== "triage") return null;
  return older.revisions.some((r) => r.note === "Edited") ? KEPT_EDITED : "supersede";
}

/** Whether `p` is a comment an agent run left for its ticket, other than a plan's: what a finished run drafts on its own. As `is_run_comment`. */
export const isRunComment = (p: Proposal) => p.origin.type === "run" && p.intent.type === "comment" && machineMade(p) && !p.label?.startsWith(PLAN_COMMENT_LABEL) && p.label !== READINESS_COMMENT_LABEL;

/**
 * What a new run comment does to an older pending one, as `run_comment_supersession` in `proposals.rs`: the same ticket in
 * the same workstream, made by an agent run of the same kind (`kindOf` says a run's kind; a run it can't find supersedes
 * nothing). The person's edit keeps it (the audit line says so); anything else is replaced. Null when it is another
 * ticket, workstream or kind, a plan's comment, not pending, or back in Pending after a failed post (`error` is set).
 */
export function runCommentSupersession(older: Proposal, newer: Proposal, kindOf: (runId: string) => RunKind | null): "supersede" | typeof KEPT_EDITED | null {
  const ws = workstreamOf(newer);
  if (!ws || !isRunComment(older) || !isRunComment(newer) || workstreamOf(older) !== ws || older.id === newer.id || older.state.type !== "pending" || older.error) return null;
  const [on, to] = [targetOf(older.intent), targetOf(newer.intent)];
  if (!on || !to || on.connectionId !== to.connectionId || on.externalId !== to.externalId) return null;
  if (older.origin.type !== "run" || newer.origin.type !== "run") return null;
  const [was, now] = [kindOf(older.origin.runId), kindOf(newer.origin.runId)];
  if (!was || was !== now) return null;
  return older.revisions.some((r) => r.note === "Edited") ? KEPT_EDITED : "supersede";
}

/**
 * The older pending review drafts of the same pull request that a newer review `p` left standing, with why: the person
 * edited them, or GitHub may have them already. Each is still waiting beside `p`.
 */
export function keptOlderReviews(p: Proposal, all: readonly Proposal[]): { proposal: Proposal; why: typeof KEPT_EDITED | typeof KEPT_MAYBE_POSTED }[] {
  if (!isRunReview(p)) return [];
  return all.flatMap((older) => {
    if (older.createdAt > p.createdAt) return [];
    const why = reviewSupersession(older, p);
    return why === KEPT_EDITED || why === KEPT_MAYBE_POSTED ? [{ proposal: older, why }] : [];
  });
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
