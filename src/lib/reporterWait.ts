import type { Proposal, WorkstreamEvent } from "../types";
import { isAnswersDraft } from "./proposals";

/** Where a workstream stands with the reporter, read from its audit, as `ReporterFollow` in src-tauri/src/inbox/workstreams.rs. */
export interface ReporterFollow {
  /** Waiting on the reporter since then: the asked comment was approved and nothing has ended the wait. */
  waiting: string | null;
  /** The wait ended because the ticket changed or the reporter replied (`replied`), and the person hasn't chosen since: the readiness question comes back. */
  changed: boolean;
  /** The wait ended with a comment on the ticket from someone other than the person, newer than the wait's start: how a reporter usually answers, which leaves no audit line. Implies `changed`. */
  replied: boolean;
}

/** The parts of an audit line the wait is read from. */
export type FollowLine = Pick<WorkstreamEvent, "actor" | "action" | "proposalId" | "at">;

/**
 * `ReporterFollow` of the audit `events` (oldest first), as `reporter_follow`: the wait starts when the comment of a
 * `readiness_asked` or `clarity_asked` is approved, and ends at the first of the ticket changing (`basis_drifted`, the
 * supervisor's), the reporter replying, the person choosing to answer or plan anyway, or resuming. Only the person's own
 * lines count as theirs. Both sides run src/lib/reporterWait.fixtures.json. `replies` are the times (ISO) of the ticket's comments from anyone but the signed-in person: a
 * Jira comment leaves no audit line, so one newer than the wait's start ends it, placed among the audit lines by its time.
 */
export function reporterFollow(events: readonly FollowLine[], replies: readonly string[] = []): ReporterFollow {
  const asked = new Set<string>();
  let now: ReporterFollow = { waiting: null, changed: false, replied: false };
  const times = replies.map((r) => Date.parse(r)).filter((t) => !Number.isNaN(t)).sort((a, b) => a - b);
  let next = 0;
  const reply = (t: number) => {
    if (now.waiting && t > Date.parse(now.waiting)) now = { waiting: null, changed: true, replied: true };
  };
  for (const e of events) {
    while (next < times.length && times[next] < Date.parse(e.at)) reply(times[next++]);
    const person = e.actor === "person";
    if (person && (e.action === "readiness_asked" || e.action === "clarity_asked")) {
      if (e.proposalId) asked.add(e.proposalId);
      now = { ...now, changed: false, replied: false };
    } else if (person && e.action === "draft_approved" && e.proposalId && asked.has(e.proposalId)) now = { waiting: e.at, changed: false, replied: false };
    else if (person && (e.action === "readiness_answered" || e.action === "readiness_overridden")) now = { waiting: null, changed: false, replied: false };
    else if (e.actor === "supervisor" && e.action === "basis_drifted" && now.waiting) now = { waiting: null, changed: true, replied: false };
    else if (person && e.action === "resumed") now = { ...now, waiting: null };
  }
  while (next < times.length) reply(times[next++]);
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
