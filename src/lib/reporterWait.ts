import type { Proposal, WorkstreamEvent } from "../types";
import { isAnswersDraft, isReporterNudge, workstreamOf } from "./proposals";
import { WITHER_DAYS } from "./views";

/** Where a workstream stands with the reporter, read from its audit, as `ReporterFollow` in src-tauri/src/inbox/workstreams.rs. */
export interface ReporterFollow {
  /** Waiting on the reporter since then: the asked comment was approved and nothing has ended the wait. */
  waiting: string | null;
  /** The wait ended because the ticket changed, and the person hasn't chosen since: the readiness question comes back. */
  changed: boolean;
}

/** The parts of an audit line the wait is read from. */
export type FollowLine = Pick<WorkstreamEvent, "actor" | "action" | "proposalId" | "at">;

/**
 * `ReporterFollow` of the audit `events` (oldest first), as `reporter_follow`: the wait starts when the comment of a
 * `readiness_asked`, `clarity_asked` or `reporter_nudged` (a nudge posted starts it again) is approved, and ends at the first of the ticket changing (`basis_drifted`, the
 * supervisor's), the person choosing to answer or plan anyway, or resuming. Only the person's own lines count as theirs.
 */
export function reporterFollow(events: readonly FollowLine[]): ReporterFollow {
  const asked = new Set<string>();
  let now: ReporterFollow = { waiting: null, changed: false };
  for (const e of events) {
    const person = e.actor === "person";
    if (person && (e.action === "readiness_asked" || e.action === "clarity_asked" || e.action === "reporter_nudged")) {
      if (e.proposalId) asked.add(e.proposalId);
      now = { ...now, changed: false };
    } else if (person && e.action === "draft_approved" && e.proposalId && asked.has(e.proposalId)) now = { waiting: e.at, changed: false };
    else if (person && (e.action === "readiness_answered" || e.action === "readiness_overridden")) now = { waiting: null, changed: false };
    else if (e.actor === "supervisor" && e.action === "basis_drifted" && now.waiting) now = { waiting: null, changed: true };
    else if (person && e.action === "resumed") now = { ...now, waiting: null };
  }
  return now;
}

/**
 * Whether the newest of the person's readiness choices (`readiness_asked`, `readiness_answered`, `readiness_overridden`) is
 * "I'll answer" and no comment with their answers was drafted after it among `drafts`, whatever its state: Pip's next turn
 * drafts it. As `answers_due` in src-tauri/src/agent/workstream.rs.
 */
export function answersDue(events: readonly Pick<WorkstreamEvent, "actor" | "action" | "at">[], drafts: readonly Pick<Proposal, "intent" | "label" | "createdBy" | "createdAt">[]): boolean {
  const chosen = [...events].reverse().find((e) => e.actor === "person" && ["readiness_asked", "readiness_answered", "readiness_overridden"].includes(e.action));
  if (chosen?.action !== "readiness_answered") return false;
  return !drafts.some((p) => isAnswersDraft(p as Proposal) && p.createdAt >= chosen.at);
}

/**
 * Whether the plan is due after the person's answers: the newest of their readiness choices is "I'll answer", the comment
 * with their answers (drafted after it) was posted, and no plan was drafted or started since. Pip's next turn proposes it,
 * not before: the plan is drafted next to a comment that is not posted yet only to confuse which is waiting. `workstream` is
 * the workstream's id, which the plan drafts and runs carry.
 */
export function planDue(
  events: readonly Pick<WorkstreamEvent, "actor" | "action" | "at">[],
  drafts: readonly Pick<Proposal, "intent" | "label" | "createdBy" | "createdAt" | "state">[],
  runs: readonly { spec: { kind: string; workstream?: string | null }; queuedAt: string }[],
  workstream: string,
): boolean {
  const chosen = [...events].reverse().find((e) => e.actor === "person" && ["readiness_asked", "readiness_answered", "readiness_overridden"].includes(e.action));
  if (chosen?.action !== "readiness_answered") return false;
  const answers = drafts.filter((p) => isAnswersDraft(p as Proposal) && p.createdAt >= chosen.at).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  if (answers?.state.type !== "applied") return false;
  const drafted = drafts.some((p) => p.intent.type === "startRun" && p.intent.spec.kind === "plan" && p.intent.spec.workstream === workstream && p.createdAt >= answers.createdAt);
  return !drafted && !runs.some((r) => r.spec.kind === "plan" && r.spec.workstream === workstream && r.queuedAt >= answers.createdAt);
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** How long ago `iso` was, in words that follow "since": "2 days ago", "yesterday", "3 hours ago", "just now". */
export function agoText(iso: string, now: Date): string {
  const minutes = Math.max(0, Math.floor((now.getTime() - Date.parse(iso)) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${plural(minutes, "minute", "minutes")} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${plural(hours, "hour", "hours")} ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "yesterday" : `${days} days ago`;
}

/** What a workstream says while it waits on the reporter: the Next line (after "Next: ") says this. */
export const waitingOnReporterText = (since: string, now: Date) => `Waiting on the reporter since ${agoText(since, now)}; nothing starts on its own.`;

/** The row's short status while it waits on the reporter. */
export const WAITING_STATUS = "Waiting on the reporter";

/** How many whole days the reporter may stay silent before a nudge is offered: the cobweb's first stage (`WITHER_DAYS.ticket`), as `NUDGE_AFTER_DAYS` in src-tauri/src/inbox/workstreams.rs. */
export const NUDGE_AFTER_DAYS = WITHER_DAYS.ticket[0];

/** Why a nudge to the reporter is refused: nobody is waited on, it is too soon, or one waits already. As `NUDGE_GONE` in src-tauri/src/inbox/workstreams.rs. */
export const NUDGE_GONE = "This workstream isn't due a nudge to the reporter.";

/** Whole days the workstream has waited on the reporter since `since`, at `now`. */
export const waitedDays = (since: string, now: Date) => Math.max(0, Math.floor((now.getTime() - Date.parse(since)) / 86_400_000));

/**
 * Whether "Draft a nudge" is offered: the workstream has waited on the reporter for `NUDGE_AFTER_DAYS` days or more and no
 * nudge waits among `drafts` (the drafts in the workstream; only the pending and applying ones count).
 */
export function nudgeOffered(wait: { since: string } | null | undefined, now: Date, drafts: readonly Pick<Proposal, "intent" | "label" | "createdBy" | "state" | "origin">[], workstream: string): boolean {
  if (!wait || Number.isNaN(Date.parse(wait.since)) || waitedDays(wait.since, now) < NUDGE_AFTER_DAYS) return false;
  return !drafts.some((p) => isReporterNudge(p as Proposal) && (p.state.type === "pending" || p.state.type === "applying") && workstreamOf(p as Proposal) === workstream);
}

/** What the Next line adds once the nudge is offered: "The reporter hasn't answered for 3 days. You can draft a nudge." */
export const nudgeText = (days: number) => `The reporter hasn't answered for ${plural(days, "day", "days")}. You can draft a nudge.`;

/** What the nudge comment says, as `nudge_comment` in src-tauri/src/inbox/workstreams.rs. */
export function nudgeComment(key: string, reporter: string | null): string {
  const hello = reporter ? `Hi @${reporter},` : "Hi,";
  return `${hello}\n\nA gentle nudge on the questions above; we can't plan ${key} until they are cleared up. Could you answer them here on the ticket when you have a moment? Thanks.`;
}
