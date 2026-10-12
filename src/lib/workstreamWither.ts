import type { Intent, Proposal, Run, WorkstreamEvent } from "../types";
import { WITHER_DAYS, witherLevel, type WitherLevel } from "./views";

/**
 * A workstream's cobweb: "work is happening but Jira hasn't heard". It reuses the stages a ticket row withers by
 * (`WITHER_DAYS.ticket`, `witherLevel`) and the same `Cobweb`, with a different clock: the days since the person last posted
 * to Jira or GitHub for the workstream, or, with no post yet, since it opened. It only counts while the agents or Pip have
 * been at work since that post (runs started or finished, Pip's turns), so a workstream where nothing happens shows none:
 * the ticket's own cobweb in the ticket list covers a ticket nobody touches. It is never a need and is counted nowhere.
 */

/** What a post to Jira writes: every kind of draft a tracker applies. A run, a follow-up or an answer reaches an agent, not Jira. */
const JIRA_WRITES: ReadonlySet<Intent["type"]> = new Set(["comment", "transition", "subtasks", "rewrite", "create", "update", "link"]);

/** The parts of a run the clock reads. */
export type WitherRun = Pick<Run, "launchedAt" | "endedAt"> & Partial<Pick<Run, "id">>;

/** The parts of a draft the clock reads: what it is and where it stands. */
export type WitherDraft = Pick<Proposal, "intent" | "state">;

export interface WorkstreamWither {
  /** `WITHER_DAYS.ticket`'s stage for the days since the last post; 0 while nothing has happened since it, or it is fresh. */
  level: WitherLevel;
  /** Whole days since the last post, or since the workstream opened. */
  days: number;
  /** When the clock started: the person's last post to Jira or GitHub, else when the workstream opened; null when neither is known. */
  since: string | null;
  /** How many runs started or finished since. */
  runs: number;
  /** How many Pip turns since. */
  turns: number;
  /** The words for hover and for a screen reader: "No Jira update for 5 days (3 runs since)"; empty at level 0. */
  text: string;
}

export interface WitherMore {
  /** A draft by id, so that an approved draft is told from a post: only an applied (or applying) Jira write counts. */
  draft?(id: string): WitherDraft | undefined;
  /** The workstream's conversation with Pip, when it is known; otherwise the audit's `wake` lines stand for Pip's turns. */
  turns?: readonly { at?: string | null }[] | null;
  /** When the workstream opened, when the audit has no `opened` line. */
  openedAt?: string | null;
}

const at = (iso: string | null | undefined) => (iso ? Date.parse(iso) : NaN);

/** Whether the audit line is the person's post to Jira or GitHub: an approved (applied) Jira write, or a review they posted. */
export function isPost(e: WorkstreamEvent, draft?: (id: string) => WitherDraft | undefined): boolean {
  if (e.actor !== "person") return false;
  if (e.action === "review_posted" || e.action === "escalation_posted") return true;
  if (e.action !== "draft_approved" || !e.proposalId) return false;
  const p = draft?.(e.proposalId);
  // A draft that is not known, or whose approval didn't reach Jira, hasn't told Jira anything.
  return !!p && JIRA_WRITES.has(p.intent.type) && (p.state.type === "applied" || p.state.type === "applying");
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "(3 runs since)", "(2 Pip turns since)" or "(3 runs and 2 Pip turns since)". */
function sinceText(runs: number, turns: number): string {
  const parts = [runs ? plural(runs, "run", "runs") : "", turns ? plural(turns, "Pip turn", "Pip turns") : ""].filter(Boolean);
  return `(${parts.join(" and ")} since)`;
}

/** The workstream's cobweb at `now`, from its audit `events`, its `runs` and what `more` knows. Pure. */
export function workstreamWither(events: readonly WorkstreamEvent[], runs: readonly WitherRun[], now: Date, more: WitherMore = {}): WorkstreamWither {
  const none: WorkstreamWither = { level: 0, days: 0, since: null, runs: 0, turns: 0, text: "" };
  const posts = events.filter((e) => isPost(e, more.draft)).map((e) => e.at);
  const last = posts.length ? posts.reduce((a, b) => (at(b) > at(a) ? b : a)) : null;
  const since = last ?? events.find((e) => e.action === "opened")?.at ?? more.openedAt ?? null;
  const from = at(since);
  if (!since || Number.isNaN(from)) return none;
  const after = (iso: string | null | undefined) => at(iso) > from;
  const worked = runs.filter((r) => after(r.launchedAt) || after(r.endedAt)).length;
  const turns = more.turns ? more.turns.filter((t) => after(t.at)).length : events.filter((e) => e.action === "wake" && after(e.at)).length;
  const days = Math.max(0, Math.floor((now.getTime() - from) / 86_400_000));
  const level = worked + turns > 0 ? witherLevel(since, now, WITHER_DAYS.ticket) : 0;
  return { level, days, since, runs: worked, turns, text: level ? `No Jira update for ${plural(days, "day", "days")} ${sinceText(worked, turns)}` : "" };
}
