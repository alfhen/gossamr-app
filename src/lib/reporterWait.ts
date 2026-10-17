import type { Proposal, ReporterReply, ReporterReplyAt, WorkstreamEvent } from "../types";
import { isAnswersDraft, isReporterNudge, workstreamOf } from "./proposals";
import { WITHER_DAYS } from "./views";

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
 * `readiness_asked`, `clarity_asked` or `reporter_nudged` (a nudge posted starts it again) is approved, and ends at the
 * first of the ticket changing (`basis_drifted`, the supervisor's), the reporter replying, the person choosing to answer or
 * plan anyway, or resuming. Only the person's own lines count as theirs. Both sides run src/lib/reporterWait.fixtures.json.
 * `replies` are the times (ISO) of the ticket's comments from anyone but the signed-in person: a Jira comment leaves no
 * audit line, so one newer than the wait's start ends it, placed among the audit lines by its time.
 */
export function reporterFollow(events: readonly FollowLine[], replies: readonly string[] = []): ReporterFollow {
  return followWithReply(events, replies).follow;
}

/**
 * `reporterFollow` and, while the reporter's reply is what ended the wait (`follow.replied`), the time of the first comment
 * that did: what the timeline's "The reporter replied on the ticket" is placed by. As `reporter_follow_at` in src-tauri/src/inbox/workstreams.rs.
 */
export function followWithReply(events: readonly FollowLine[], replies: readonly string[] = []): { follow: ReporterFollow; repliedAt: string | null } {
  const asked = new Set<string>();
  let repliedAt: string | null = null;
  let now: ReporterFollow = { waiting: null, changed: false, replied: false };
  const stamped = replies.map((r) => ({ t: Date.parse(r), iso: r })).filter((r) => !Number.isNaN(r.t)).sort((a, b) => a.t - b.t);
  const times = stamped.map((r) => r.t);
  let next = 0;
  const reply = (t: number) => {
    if (now.waiting && t > Date.parse(now.waiting)) (now = { waiting: null, changed: true, replied: true }), (repliedAt = stamped.find((r) => r.t === t)!.iso);
  };
  for (const e of events) {
    while (next < times.length && times[next] < Date.parse(e.at)) reply(times[next++]);
    const person = e.actor === "person";
    if (person && (e.action === "readiness_asked" || e.action === "clarity_asked" || e.action === "reporter_nudged")) {
      if (e.proposalId) asked.add(e.proposalId);
      now = { ...now, changed: false, replied: false };
    } else if (person && e.action === "draft_approved" && e.proposalId && asked.has(e.proposalId)) now = { waiting: e.at, changed: false, replied: false };
    else if (person && (e.action === "readiness_answered" || e.action === "readiness_overridden")) now = { waiting: null, changed: false, replied: false };
    else if (e.actor === "supervisor" && e.action === "basis_drifted" && now.waiting) now = { waiting: null, changed: true, replied: false };
    else if (person && e.action === "resumed") now = { ...now, waiting: null };
    // "Looks fine" after the reply is the person choosing: the reply is read, though the ticket still counts as changed.
    else if (person && e.action === "clarity_dismissed") now = { ...now, replied: false };
  }
  while (next < times.length) reply(times[next++]);
  return { follow: now, repliedAt: now.replied ? repliedAt : null };
}

/** When the reporter was asked on a workstream, and when nudged after that ask; what the readiness decision says the person already did. */
export interface ReporterAsk {
  asked: string;
  nudged: string | null;
  /** The first comment from someone but the person after the ask, as its time; null while nobody has answered. */
  replied: string | null;
}

/**
 * The newest ask to the reporter among the audit `events` (oldest first), as its approval time, and the nudge approved after
 * it, if any. Unlike `reporterFollow` it outlives the reporter's reply or the ticket changing, and ends only when the person
 * chooses to answer or plan anyway. Null when the reporter was not asked.
 */
export function reporterAsk(events: readonly FollowLine[], replies: readonly string[] = []): ReporterAsk | null {
  const kinds = new Map<string, "ask" | "nudge">();
  let now = null as ReporterAsk | null;
  for (const e of events) {
    if (e.actor !== "person") continue;
    if (e.action === "readiness_asked" || e.action === "clarity_asked" || e.action === "reporter_nudged") {
      if (e.proposalId) kinds.set(e.proposalId, e.action === "reporter_nudged" ? "nudge" : "ask");
    } else if (e.action === "draft_approved" && e.proposalId && kinds.has(e.proposalId)) {
      if (kinds.get(e.proposalId) === "ask") now = { asked: e.at, nudged: null, replied: null };
      else if (now) now = { ...now, nudged: e.at };
    } else if (e.action === "readiness_answered" || e.action === "readiness_overridden") now = null;
  }
  if (!now) return null;
  const since = Date.parse(now.asked);
  const first = replies.filter((r) => Date.parse(r) > since).sort((a, b) => Date.parse(a) - Date.parse(b))[0];
  return { ...now, replied: first ?? null };
}

/** How many characters of a reply the quote keeps. As `REPLY_EXCERPT` in src-tauri/src/inbox/workstreams.rs. */
export const REPLY_EXCERPT = 140;

/** How far back from the cut the excerpt looks for a space to end on. As `REPLY_WORD_BACK` in src-tauri/src/inbox/workstreams.rs. */
export const REPLY_WORD_BACK = 20;

/** How many lines of a reply the quote keeps. As `REPLY_LINES` in src-tauri/src/inbox/workstreams.rs. */
export const REPLY_LINES = 2;

/**
 * The first two lines of a comment's text with their spacing made even, each cut to `REPLY_EXCERPT` characters (at a word when one ends near the cut) with "…", on
 * two lines of their own, and " (+N more)" after them when N more lines follow, so a numbered reply doesn't read as one item.
 * As `reply_excerpt` in src-tauri/src/inbox/workstreams.rs.
 */
export function replyExcerpt(text: string): string {
  const lines = text.split(/\n/).map((l) => l.split(/\s+/).filter(Boolean).join(" ")).filter((l) => l);
  const shown = lines.slice(0, REPLY_LINES).map((line) => {
    const chars = Array.from(line);
    if (chars.length <= REPLY_EXCERPT) return line;
    // Back up to the last space when one is near, so the cut doesn't land inside a word.
    const cut = chars.slice(0, REPLY_EXCERPT - 1);
    const space = cut.lastIndexOf(" ");
    const end = chars[REPLY_EXCERPT - 1] !== " " && space >= REPLY_EXCERPT - 1 - REPLY_WORD_BACK ? space : cut.length;
    return `${cut.slice(0, end).join("").trimEnd()}…`;
  });
  const more = lines.length - shown.length;
  return `${shown.join("\n")}${more > 0 ? ` (+${more} more)` : ""}`;
}

/** When the first reporter ask of the audit `events` was posted (the approval of a `readiness_asked`, `clarity_asked` or `reporter_nudged` comment), as epoch milliseconds; null while the reporter has not been asked. As `first_ask_posted` in src-tauri/src/inbox/workstreams.rs. */
export function firstAskPosted(events: readonly FollowLine[]): number | null {
  const asked = new Set<string>();
  for (const e of events) {
    if (e.actor !== "person") continue;
    if (e.action === "readiness_asked" || e.action === "clarity_asked" || e.action === "reporter_nudged") {
      if (e.proposalId) asked.add(e.proposalId);
    } else if (e.action === "draft_approved" && e.proposalId && asked.has(e.proposalId)) {
      const at = Date.parse(e.at);
      return Number.isNaN(at) ? null : at;
    }
  }
  return null;
}

/**
 * Whether the reporter answered what a Triage that finished at `since` (ISO; none: any time) left open: a comment from someone but the person
 * (`replies`, their times) came after the first ask was posted and after `since`. A Triage that ran after the reply had the
 * answer in its prompt, so what it still lists is open. As `answered_by_reply` in src-tauri/src/inbox/workstreams.rs.
 */
export function answeredByReply(events: readonly FollowLine[], replies: readonly string[], since = ""): boolean {
  const ask = firstAskPosted(events);
  const from = Date.parse(since);
  return ask !== null && replies.some((r) => Date.parse(r) > ask && !(Date.parse(r) <= from));
}

/**
 * Every comment on the ticket from someone but the person that came after the first reporter ask was posted on the workstream
 * (the approval of a `readiness_asked`, `clarity_asked` or `reporter_nudged` comment), oldest first, each as its quote: the
 * replies the timeline keeps telling after the person asks again, which ends the wait they ended. A comment that says nothing is
 * left out. As `reporter_replies` in src-tauri/src/inbox/workstreams.rs; both run the `replies` of src/lib/reporterWait.fixtures.json.
 */
export function reporterReplies(events: readonly FollowLine[], comments: readonly { id: string; at: string; text: string }[]): ReporterReplyAt[] {
  const first = firstAskPosted(events);
  if (first === null || Number.isNaN(first)) return [];
  return comments
    .map((c) => ({ c, t: Date.parse(c.at) }))
    .filter(({ t }) => !Number.isNaN(t) && t > first!)
    .sort((a, b) => a.t - b.t)
    .flatMap(({ c }) => {
      const excerpt = replyExcerpt(c.text);
      return excerpt ? [{ id: c.id, excerpt, at: c.at }] : [];
    });
}

/**
 * The comment that ended the wait: the one written at `repliedAt` among `comments` (the ticket's comments from anyone but
 * the person, with their `at` times and plain text), as the view's `reporterReply`. Null without a reply or a comment at that time, or when it says nothing.
 * As `reply_to` in src-tauri/src/inbox/workstreams.rs; both run the `reply` of src/lib/reporterWait.fixtures.json.
 */
export function replyComment(comments: readonly { id: string; at: string; text: string }[], repliedAt: string | null): ReporterReply | null {
  const c = repliedAt ? comments.find((k) => k.at === repliedAt) : undefined;
  const excerpt = c ? replyExcerpt(c.text) : "";
  return c && excerpt ? { id: c.id, excerpt } : null;
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

/** The questions an ask comment lists: its bullet lines, as the person left them, without the dash. As `asked_questions` in src-tauri/src/inbox/workstreams.rs. */
export const askedQuestions = (ask: string): string[] => ask.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("- ")).map((l) => l.slice(2).trim()).filter(Boolean);

/**
 * What the nudge comment says, as `nudge_comment` in src-tauri/src/inbox/workstreams.rs, with the questions still open (`open`,
 * the bullets of the newest ask) listed under it. Once the reporter has replied before the ask now open (`replied`), it
 * follows up on that ask rather than the first. Jira's words, in a neutral voice: no "I" or "we", no stage words, nothing of Gossamr's, no "above".
 */
export function nudgeComment(key: string, reporter: string | null, replied = false, open: readonly string[] = []): string {
  const hello = reporter ? `Hi @${reporter},` : "Hi,";
  const questions = replied ? "follow-up questions" : "earlier questions";
  if (!open.length) return `${hello}\n\nThe ${questions} about ${key} are still open. Could you answer them here on the ticket when you have a moment? Thanks.`;
  return `${hello}\n\nThe ${questions} about ${key} are still open:\n\n${open.map((q) => `- ${q}`).join("\n")}\n\nCould you answer them here on the ticket when you have a moment? Thanks.`;
}
