import type { PersonRef, Run, WorkItem, WorkPriority, WorkstreamView } from "../types";
import { docText } from "./docs";
import { clarityGaps, clarityQuestions, gapsPhrase, type ClarityGap } from "./ticketClarity";
import { flaggedGaps, projectOfKey, type ClarityLearning } from "./clarityLearning";
import { byRank, type Need } from "./needs";
import { workstreamStatus } from "./workstreamStatus";
import type { WorkstreamWither } from "./workstreamWither";

/**
 * Plan my week: a short, ordered list of what to work on this week, from the person's open workstreams and their assigned
 * tickets. It is a pure ranking, so the same page gives the same list: no agent turn, no automatic step, nothing written to
 * Jira. The list is a proposal; the person reorders it, removes from it, adds to it and keeps it (`keepPlan`).
 *
 * What it reads: Needs you (always first), the workstream's status (`workstreamStatus`: waiting on the reporter and held
 * ones are left out, they can't move this week), the ticket's priority, its age, whether its description reads thin (the
 * readiness signal that exists before any Triage; a Triage that found the ticket not ready is a need already), the cobweb and
 * whether work is already going. There is no structured Triage size or estimate to read: a Triage's "size 3" is a sentence
 * in its result for Jira, not a field, so size is not a signal here.
 */

/** How many picks the proposal holds unless told otherwise. */
export const WEEK_PICKS = 3;

export interface PlanPick {
  /** Stable: `ws:<workstream id>` or `ticket:<connection>:<KEY>` (the same key on two connections is two tickets; plans kept before this hold `ticket:<KEY>`). */
  id: string;
  kind: "workstream" | "ticket";
  workstreamId: string | null;
  ticketKey: string | null;
  /** The Jira connection the ticket or workstream is on; a key alone is not unique across connections. Plans kept before this was stored have none, and match by key. */
  connectionId?: string;
  /** The key and title, or the workstream's title. */
  title: string;
  /** One line saying why it is on the list: "because 2 things need you here". */
  because: string;
  /**
   * `clarify` when the work is not building but asking the reporter: the ticket reads thin, so the pick says "Clarify CA-408
   * with the reporter" and the week gets at most one of them (`planMyWeek`). Absent for any other work.
   */
  work?: "clarify";
  /** The person took a ticked item back (`reopenItem`): it stays open however its workstream or ticket stands. Only a kept plan carries it. */
  reopened?: boolean;
}

export interface PlanInput {
  /** Every workstream, open or closed; only the open ones are candidates. */
  workstreams: readonly WorkstreamView[];
  items: readonly WorkItem[];
  /** The signed-in person's accounts: a ticket is a candidate when assigned to one of them. */
  me: readonly PersonRef[];
  needs: readonly Need[];
  runs: readonly Run[];
  /** The workstreams' cobwebs, by id. */
  withers?: Readonly<Record<string, WorkstreamWither>>;
  learning?: ClarityLearning;
  now: Date;
  /** How many picks to propose; `WEEK_PICKS` by default. */
  count?: number;
}

const PRIORITY: Record<WorkPriority, number> = { lowest: 0, low: 1, medium: 2, high: 4, highest: 6 };
const DAY = 86_400_000;
const GROUPS = ["decide", "unblock", "approve"];
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const isMine = (item: WorkItem, me: readonly PersonRef[]) => !!item.assignee && me.some((m) => m.connectionId === item.assignee!.connectionId && m.accountId === item.assignee!.accountId);
const ticketOf = (items: readonly WorkItem[], connectionId: string, key: string) => items.find((t) => t.item.connectionId === connectionId && t.item.key === key);
/** What tells this ticket from the next on a line: its priority when it is not the middle one, and its age. "high priority, 9 days old"; empty when nothing is known. */
function facts(t: WorkItem | undefined, now: Date): string {
  if (!t) return "";
  const age = days(t.created, now);
  return [t.priority && t.priority !== "medium" ? `${t.priority} priority` : "", age > 0 ? `${plural(age, "day", "days")} old` : ""].filter(Boolean).join(", ");
}
const days = (iso: string | null | undefined, now: Date) => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(t) ? 0 : Math.max(0, Math.floor((now.getTime() - t) / DAY));
};

interface Scored {
  pick: PlanPick;
  /** 0 for a workstream with a need in it, else 1. */
  tier: 0 | 1;
  score: number;
  /** The oldest need's time, for the first tier: oldest first, as Needs you ranks within a group. */
  at: string;
}

/** The because line of a pick that asks the reporter: what is thin, how many questions that is, and what tells it from another. */
const clarifyLine = (lead: string, how: string, gaps: readonly ClarityGap[]) => `${lead}${how}, but it ${gapsPhrase(gaps)}; ask the reporter ${plural(clarityQuestions(gaps).length, "question", "questions")} before anyone builds on it.`;

/** Every candidate, ranked: Needs you first (Needs you's own order: decide, unblock, approve, oldest first), then by score, then by key. Left out: closed, held, waiting on the reporter, done. */
export function rankWeek(i: PlanInput): PlanPick[] {
  const scored: Scored[] = [];
  const opened = new Set<string>();
  // Needs in General that are about a ticket (workstreamId null, ticketKey set): a pending decision on a ticket still counts for it, workstream or not.
  // A need carries a key and no connection, but a run's need can be placed through its run; one with no run (a draft) is matched
  // only where that key is on one connection among the candidates, since the same key on two is two tickets.
  const connections = new Map<string, Set<string>>();
  const seen = (conn: string, key: string) => connections.set(key, (connections.get(key) ?? new Set()).add(conn));
  for (const v of i.workstreams) if (v.workstream.closedAt === null && v.workstream.itemKey) seen(v.workstream.connectionId, v.workstream.itemKey);
  for (const t of i.items) seen(t.item.connectionId, t.item.key);
  const runConnection = new Map(i.runs.map((r) => [r.id, r.item?.connectionId ?? r.connectionId]));
  const general = new Map<string, Need[]>();
  for (const n of [...i.needs].sort(byRank)) {
    if (n.workstreamId !== null || !n.ticketKey) continue;
    const conn = (n.runId && runConnection.get(n.runId)) || (connections.get(n.ticketKey)?.size === 1 ? [...connections.get(n.ticketKey)!][0] : undefined);
    if (conn) general.set(`${conn}:${n.ticketKey}`, [...(general.get(`${conn}:${n.ticketKey}`) ?? []), n]);
  }
  const needLine = (list: readonly Need[], t?: WorkItem) => `${plural(list.length, "thing needs", "things need")} you here: ${list[0].title}.${facts(t, i.now) ? ` It is ${facts(t, i.now)}.` : ""}`;
  const needScore = (n: Need) => 3 - GROUPS.indexOf(n.group);
  for (const v of i.workstreams) {
    const ws = v.workstream;
    if (ws.closedAt !== null) continue;
    if (ws.itemKey) opened.add(`${ws.connectionId}:${ws.itemKey}`);
    const mine = i.needs.filter((n) => n.workstreamId === ws.id).sort(byRank);
    const status = workstreamStatus(v, i.needs, { runs: i.runs, wither: i.withers?.[ws.id] ?? null, now: i.now });
    const name = ws.itemKey ? `${ws.itemKey} ${ws.title.startsWith(ws.itemKey) ? ws.title.slice(ws.itemKey.length).trim() || ws.title : ws.title}` : ws.title;
    const t = ws.itemKey ? ticketOf(i.items, ws.connectionId, ws.itemKey) : undefined;
    const pick = (because: string, work?: PlanPick["work"], title = name): PlanPick => ({ id: `ws:${ws.id}`, kind: "workstream", workstreamId: ws.id, ticketKey: ws.itemKey, connectionId: ws.connectionId, title, because, ...(work ? { work } : {}) });
    if (status.state === "needs-you") {
      scored.push({ pick: pick(`${plural(mine.length, "thing needs", "things need")} you here: ${mine[0]?.title ?? "a decision"}.${facts(t, i.now) ? ` It is ${facts(t, i.now)}.` : ""}`), tier: 0, score: 3 - GROUPS.indexOf(mine[0]?.group ?? "approve"), at: mine[0]?.at ?? ws.createdAt });
      continue;
    }
    if (status.state === "held" || status.state === "waiting" || status.state === "done") continue;
    const loose = ws.itemKey ? general.get(`${ws.connectionId}:${ws.itemKey}`) : undefined;
    if (loose) {
      scored.push({ pick: pick(needLine(loose, t)), tier: 0, score: needScore(loose[0]), at: loose[0].at });
      continue;
    }
    const age = days(ws.createdAt, i.now);
    let score = 8 + Math.min(age, 14) / 2;
    const urgent = t?.priority === "high" || t?.priority === "highest" ? `${t.priority} priority, ` : "";
    let because = `${urgent}${age === 0 ? "opened today" : `open for ${plural(age, "day", "days")}`}, nothing is moving it.`;
    // The word check still finds the ticket thin and nobody has asked or triaged: what it needs is a question, not a build. Ranked down less than a ticket with no workstream (-6): the person already opened it.
    const gaps = status.state === "idle" && ws.itemKey ? flaggedGaps(v.clarity?.gaps ?? [], i.learning ?? {}, projectOfKey(ws.itemKey)) : [];
    if (ws.itemKey && gaps.length) {
      scored.push({ pick: pick(clarifyLine(urgent, `open for ${plural(age, "day", "days")}`, gaps), "clarify", `Clarify ${ws.itemKey} with the reporter`), tier: 1, score: score - 3, at: ws.createdAt });
      continue;
    }
    if (status.state === "running") (score += 5, (because = "work is already going; keep it moving."));
    else if (status.state === "quiet") (score += 10, (because = `${status.detail ?? "quiet"}; Jira has not heard from it.`.replace(/^No Jira update · (\d+)d;/, "no Jira update for $1 days;")));
    scored.push({ pick: pick(because), tier: 1, score, at: ws.createdAt });
  }
  for (const t of i.items) {
    if (t.status.category === "done" || opened.has(`${t.item.connectionId}:${t.item.key}`)) continue;
    const loose = general.get(`${t.item.connectionId}:${t.item.key}`);
    if (!loose && !isMine(t, i.me)) continue;
    if (loose) {
      scored.push({ pick: { id: `ticket:${t.item.connectionId}:${t.item.key}`, kind: "ticket", workstreamId: null, ticketKey: t.item.key, connectionId: t.item.connectionId, title: `${t.item.key} ${t.title}`, because: needLine(loose, t) }, tier: 0, score: needScore(loose[0]), at: loose[0].at });
      continue;
    }
    const age = days(t.created, i.now);
    const gaps = flaggedGaps(clarityGaps(docText(t.body)), i.learning ?? {}, projectOfKey(t.item.key));
    let score = (t.priority ? PRIORITY[t.priority] : 2) + Math.min(age, 30) / 5;
    let because = t.priority === "high" || t.priority === "highest" ? `${t.priority} priority, assigned to you, no workstream yet.` : `assigned to you ${age === 0 ? "today" : `for ${plural(age, "day", "days")}`}, no workstream yet.`;
    // Unclear work is asking the reporter, not building: said as such, with what tells this ticket from the next.
    const clarify = gaps.length > 0;
    if (clarify) (score -= 6, (because = clarifyLine(t.priority === "high" || t.priority === "highest" ? `${t.priority} priority, ` : "", `assigned to you ${age === 0 ? "today" : `for ${plural(age, "day", "days")}`}`, gaps)));
    scored.push({ pick: { id: `ticket:${t.item.connectionId}:${t.item.key}`, kind: "ticket", workstreamId: null, ticketKey: t.item.key, connectionId: t.item.connectionId, title: clarify ? `Clarify ${t.item.key} with the reporter` : `${t.item.key} ${t.title}`, because, ...(clarify ? { work: "clarify" as const } : {}) }, tier: 1, score, at: t.created });
  }
  // Needs you first (its own order: the group that is asked most, then oldest); then by score, then oldest, then by id.
  const order = (a: Scored, b: Scored) => a.tier - b.tier || b.score - a.score || a.at.localeCompare(b.at) || (a.pick.id < b.pick.id ? -1 : a.pick.id > b.pick.id ? 1 : 0);
  return scored.sort(order).map((s) => s.pick);
}

/**
 * The proposal: the first `count` of `rankWeek`, with at most one pick that asks a reporter (`work: "clarify"`): a week of
 * questions is not a plan. Further unclear tickets come only when nothing else is left to fill the week.
 */
export function planMyWeek(i: PlanInput): PlanPick[] {
  const count = Math.max(0, i.count ?? WEEK_PICKS);
  const ranked = rankWeek(i);
  const firstClarify = ranked.findIndex((p) => p.work === "clarify");
  const rest = ranked.filter((p, n) => p.work !== "clarify" || n === firstClarify);
  const picks = rest.slice(0, count);
  // Only when nothing else exists: the extra unclear ones fill what is left of the week, in their order.
  if (picks.length < count) picks.push(...ranked.filter((p) => !rest.includes(p)).slice(0, count - picks.length));
  return picks;
}

/** ISO 8601 week of `d` in local time: "2026-W42" (weeks start on Monday; week 1 holds the year's first Thursday). */
export function isoWeek(d: Date): string {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const year = t.getUTCFullYear();
  const week = Math.ceil(((t.getTime() - Date.UTC(year, 0, 1)) / DAY + 1) / 7);
  return `${year}-W${String(week).padStart(2, "0")}`;
}

/** What a kept plan stores of a pick. */
export type PlanItem = PlanPick;

/** A plan the person kept for one ISO week. */
export interface WeekPlan {
  week: string;
  keptAt: string;
  items: PlanItem[];
}

/** The kept plans by ISO week, as the prefs store them. */
export type WeekPlans = Readonly<Record<string, WeekPlan>>;

/** How many weeks of kept plans are remembered. */
export const WEEKS_KEPT = 8;

const isItem = (x: unknown): x is PlanItem => {
  const o = x as Partial<PlanItem> | null;
  return !!o && typeof o.id === "string" && (o.kind === "workstream" || o.kind === "ticket") && typeof o.title === "string" && typeof o.because === "string" && (o.workstreamId === null || typeof o.workstreamId === "string") && (o.ticketKey === null || typeof o.ticketKey === "string") && (o.connectionId === undefined || typeof o.connectionId === "string");
};

/** Reads stored plans, dropping anything malformed. */
export function parseWeekPlans(raw: unknown): WeekPlans {
  const out: Record<string, WeekPlan> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [week, p] of Object.entries(raw)) {
    const plan = p as Partial<WeekPlan> | null;
    if (!/^\d{4}-W\d{2}$/.test(week) || !plan || !Array.isArray(plan.items) || typeof plan.keptAt !== "string") continue;
    out[week] = { week, keptAt: plan.keptAt, items: plan.items.filter(isItem) };
  }
  return out;
}

/** `plans` with this week's plan set (replacing the one kept before) and only the newest `WEEKS_KEPT` weeks left. */
export function keepPlan(plans: WeekPlans, items: readonly PlanItem[], now: Date): WeekPlans {
  const week = isoWeek(now);
  const next = { ...plans, [week]: { week, keptAt: now.toISOString(), items: [...items] } };
  const weeks = Object.keys(next).sort().slice(-WEEKS_KEPT);
  return Object.fromEntries(weeks.map((w) => [w, next[w]]));
}

/** Moves item `from` to `to` (both indexes), clamped; the list itself is not changed. */
export function movePick<T>(list: readonly T[], from: number, to: number): T[] {
  if (from < 0 || from >= list.length) return [...list];
  const out = [...list];
  const [item] = out.splice(from, 1);
  out.splice(Math.max(0, Math.min(out.length, to)), 0, item);
  return out;
}

/** A pick for a ticket the person adds by hand. */
export function ticketPick(t: Pick<WorkItem, "item" | "title">): PlanPick {
  return { id: `ticket:${t.item.connectionId}:${t.item.key}`, kind: "ticket", workstreamId: null, ticketKey: t.item.key, connectionId: t.item.connectionId, title: `${t.item.key} ${t.title}`, because: "you added it." };
}

/** Where a kept item stands: still `open`, `done` (its workstream closed and the ticket is Done in Jira, or the ticket is Done), or `closed` (its workstream closed but the ticket isn't Done: dropped, not finished). */
export type ItemOutcome = "open" | "done" | "closed";

/**
 * Where a kept item stands. A workstream closed on a ticket that is not Done is `closed`, not `done`: closing a workstream
 * is also how work is dropped, so it must not read as finished. A ticket the cache doesn't hold counts as not Done. An item the
 * person reopened (`reopened`) is open, whatever else is true.
 */
export function itemOutcome(item: PlanItem, workstreams: readonly WorkstreamView[], items: readonly WorkItem[]): ItemOutcome {
  if (item.reopened) return "open";
  // The same key on another connection is another ticket; an item kept before connections were stored matches by key alone.
  const own = (connectionId: string) => item.connectionId === undefined || item.connectionId === connectionId;
  const mine = workstreams.filter((v) => v.workstream.id === item.workstreamId || (!!item.ticketKey && v.workstream.itemKey === item.ticketKey && own(v.workstream.connectionId)));
  if (mine.some((v) => v.workstream.closedAt === null)) return "open";
  const ticketDone = !!item.ticketKey && items.some((t) => t.item.key === item.ticketKey && own(t.item.connectionId) && t.status.category === "done");
  if (mine.length) return ticketDone ? "done" : "closed";
  return ticketDone ? "done" : "open";
}

/** Whether a kept item is ticked as finished: `itemOutcome` is `done`. */
export const itemDone = (item: PlanItem, workstreams: readonly WorkstreamView[], items: readonly WorkItem[]): boolean => itemOutcome(item, workstreams, items) === "done";

/** `plans` with item `id` of `week` taken back (`reopened`), so it is open again in the list; nothing else changes. */
export function reopenItem(plans: WeekPlans, week: string, id: string): WeekPlans {
  const plan = plans[week];
  if (!plan || !plan.items.some((p) => p.id === id)) return plans;
  return { ...plans, [week]: { ...plan, items: plan.items.map((p) => (p.id === id ? { ...p, reopened: true } : p)) } };
}
