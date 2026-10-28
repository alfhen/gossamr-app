import type { FeedEntry, FeedQuery, WorkstreamActor, WorkstreamEvent } from "../types";

/** The Inbox's one filter: everything, or only what mentions you. */
export type InboxFilter = "all" | "mentions";

export const FILTER_LABEL: Record<InboxFilter, string> = { all: "All", mentions: "Mentions" };

/** What the Inbox lists: comments (mentions among them), status changes and assignments on watched tickets. */
export const INBOX_KINDS: FeedEntry["kind"][] = ["commentAdded", "statusChanged", "assigned"];

/** Only the kinds the Inbox lists are asked for, so a page is never made of entries it would hide, and the unread count and Mark all read agree with the list. */
export const queryFor = (filter: InboxFilter): FeedQuery => ({ kinds: INBOX_KINDS, ...(filter === "mentions" ? { mentionsOnly: true } : {}) });

export const inInbox = (e: Pick<FeedEntry, "kind">) => INBOX_KINDS.includes(e.kind);

export interface DayGroup<T extends { at: string } = FeedEntry> {
  /** Local calendar day, `YYYY-MM-DD`. */
  day: string;
  label: string;
  entries: T[];
}

/** The local day as `2026-10-13`. */
export const dayKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export function dayLabel(at: Date, now: Date): string {
  const days = Math.round((Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) - Date.UTC(at.getFullYear(), at.getMonth(), at.getDate())) / 864e5);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return at.toLocaleDateString(undefined, { weekday: "long" });
  return at.toLocaleDateString(undefined, { day: "numeric", month: "long", year: at.getFullYear() === now.getFullYear() ? undefined : "numeric" });
}

/** Entries already in time order, split at local midnight. */
export function groupByDay<T extends { at: string }>(entries: readonly T[], now: Date): DayGroup<T>[] {
  const groups: DayGroup<T>[] = [];
  for (const entry of entries) {
    const at = new Date(entry.at);
    const day = dayKey(at);
    const last = groups[groups.length - 1];
    if (last?.day === day) last.entries.push(entry);
    else groups.push({ day, label: dayLabel(at, now), entries: [entry] });
  }
  return groups;
}

/**
 * Where a list in time order starts a new day, by the key of the first entry of that day, with the day's label ("Yesterday",
 * "Monday", "3 October"). Empty while every entry is from today: the clock times alone say enough then.
 */
export function dayBreaks<T extends { key: string; at: string }>(entries: readonly T[], now: Date): Map<string, string> {
  const out = new Map<string, string>();
  const dated = entries.map((e) => ({ key: e.key, at: new Date(e.at) })).filter((e) => !Number.isNaN(e.at.getTime()));
  const today = dayKey(now);
  if (dated.every((e) => dayKey(e.at) === today)) return out;
  let last = "";
  for (const e of dated) {
    const day = dayKey(e.at);
    if (day === last) continue;
    last = day;
    out.set(e.key, dayLabel(e.at, now));
  }
  return out;
}

export function verb(e: Pick<FeedEntry, "kind" | "mention">): string {
  switch (e.kind) {
    case "commentAdded":
      return e.mention ? "mentioned you on" : "commented on";
    case "statusChanged":
      return "moved";
    case "assigned":
      return "assigned you";
    case "itemCreated":
      return "created";
    case "prOpened":
      return "opened a pull request for";
    case "prMerged":
      return "merged a pull request for";
    case "checkFailed":
      return "had a failing check on";
    case "reviewRequested":
      return "asked you to review";
    case "prClosed":
      return "closed a pull request for";
    case "prReadyForReview":
      return "marked a pull request ready for";
    case "reviewSubmitted":
      return "reviewed a pull request for";
    case "prMentioned":
      return "mentioned you on a pull request for";
    case "fieldChanged":
      return "updated";
  }
}

export { initials } from "./canvasShared";

/** The entries whose id is in `ids` with `unread` set, the others untouched. */
export function withRead(entries: readonly FeedEntry[], ids: ReadonlySet<string>, unread: boolean): FeedEntry[] {
  return entries.map((e) => (ids.has(e.id) ? { ...e, unread } : e));
}

/** The index j and k move to, staying inside the list. -1 means nothing is active yet. */
export const stepIndex = (current: number, delta: 1 | -1, length: number): number =>
  length === 0 ? -1 : Math.min(length - 1, Math.max(0, current < 0 ? (delta === 1 ? 0 : length - 1) : current + delta));


const PAUSED_WORDS: Record<WorkstreamActor, string> = { person: "You paused the workstream", pip: "Pip paused the workstream", supervisor: "The workstream was paused", run: "The workstream was paused" };

/** What changed on a ticket, from the fields a `basis_drifted` line names. */
function driftWords(detail: string | null): string {
  const fields = (detail ?? "").split(",");
  const changed = ["summary", "description"].filter((f) => fields.includes(f));
  const done = fields.includes("status");
  if (!changed.length) return done ? "The ticket was moved to Done in Jira" : "The ticket changed in Jira";
  return `The ticket's ${changed.join(" and ")} changed${done ? " and it was moved to Done" : ""} in Jira`;
}

/**
 * What one audit line says in the feed, naming runs by their label in the workstream (`label`); null for lines the
 * feed leaves out (bookkeeping, and what an earlier version recorded).
 */
export function eventText(e: WorkstreamEvent, label: (id: string | null) => string): string | null {
  const who = e.actor === "person" ? "You" : e.actor === "pip" ? "Pip" : e.actor === "supervisor" ? "Gossamr" : "An agent";
  switch (e.action) {
    case "opened":
      return `${who} opened the workstream`;
    case "closed":
      return `${who} closed the workstream`;
    case "reopened":
      return `${who} reopened the workstream`;
    case "adopted":
      return `${who} brought ${(e.detail ?? "runs and drafts").replace(", ", " and ")} on the ticket into the workstream`;
    case "wake":
      return `Pip picked up ${label(e.runId)}`;
    case "basis_drifted":
      return driftWords(e.detail);
    case "paused":
    case "held":
      return PAUSED_WORDS[e.actor];
    case "resumed":
      return `${who} resumed the workstream`;
    case "run_approved":
      return `${who} started ${label(e.runId)}`;
    case "agent_started": {
      const role = e.detail?.split(" · ")[0]?.trim();
      return `${who} started an agent, ${label(e.runId)}${role ? ` (${role})` : ""}`;
    }
    case "agent_message_queued":
      return `${who} queued a message for ${label(e.runId)}`;
    case "agent_message_dropped":
      return `${who}'s queued message for ${label(e.runId)} was dropped`;
    case "run_resumed":
      return `${who} sent ${label(e.runId)} a message to carry on`;
    case "pip_asked":
      return "Pip asked you a question";
    case "pip_ask_cleared":
      return e.detail === "answered" ? "You answered Pip's question" : "You dismissed Pip's question";
    case "run_stopped":
      return `${who} stopped ${label(e.runId)}`;
    case "run_answered":
      return `${who} answered ${label(e.runId)}`;
    case "run_retried":
      return `${who} retried ${label(e.runId)}`;
    case "draft_approved":
      return `${who} approved a draft`;
    case "draft_skipped":
      return `${who} skipped a draft`;
    case "undone":
      return e.detail === "draft_skipped" ? `${who} brought back a skipped draft` : e.detail === "adopted" ? `${who} put the runs and drafts they brought in back under General` : `${who} undid an action`;
    case "notes_set":
      return "Pip updated its notes";
    default:
      return null;
  }
}
