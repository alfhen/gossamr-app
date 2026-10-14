import type { Proposal, WorkItem, WorkstreamView, PersonRef } from "../types";
import { docText } from "./docs";
import { clarityGaps, gapsPhrase, type ClarityGap } from "./ticketClarity";
import { flaggedGaps, projectOfKey, type ClarityLearning } from "./clarityLearning";
import { byRank, type Need, type NeedGroupKind } from "./needs";
import { inWorkstreamPane, isReporterNudge, targetOf, workstreamOf } from "./proposals";
import { nudgeOffered, waitedDays } from "./reporterWait";
import { dayKey } from "../workspace/activityLogic";
import { isJiraWrite, type WorkstreamWither } from "./workstreamWither";

/**
 * Start my day: one card on Pip home that pulls together what the day should begin with, from state the page already holds
 * (Needs you, the workstreams' views, their cobwebs, the drafts, the cached tickets). It decides nothing and counts nowhere:
 * every line is a way into something that already exists, and nothing here is a need. The builder is pure.
 */

/** How many entries a line lists before it says "and N more". */
export const DAY_ENTRIES = 3;

/** What an entry's button does; the page runs it (`runDayAction`). */
export type DayAction =
  /** Opens need `key`'s decision. */
  | { type: "need"; need: Need }
  /** Shows workstream `id` on Pip home. */
  | { type: "workstream"; id: string }
  /** Opens the ticket's peek. */
  | { type: "ticket"; key: string }
  /** Drafts the nudge to the reporter of workstream `id`, and shows the draft for approval. */
  | { type: "nudge"; id: string };

export interface DayEntry {
  key: string;
  /** What it is, in a few words: "CA-401 · R1 asks a question". */
  text: string;
  /** The button's words: "Decide", "Open workstream", "Draft a nudge". */
  label: string;
  action: DayAction;
}

export type DayKind = NeedGroupKind | "unclear" | "reporter" | "cobweb" | "drafts";

export interface DayLine {
  kind: DayKind;
  /** The count in words: "2 to decide", "1 waiting on the reporter". */
  title: string;
  /** How many things the line stands for; `entries` lists the first few of them. */
  count: number;
  entries: DayEntry[];
  /** `count` less the entries listed. */
  more: number;
  /** The entries past the first few, which "Show more" lists in place. */
  rest?: DayEntry[];
}

export interface StartMyDayInput {
  needs: readonly Need[];
  /** The open workstreams. */
  workstreams: readonly WorkstreamView[];
  /** The workstreams' cobwebs, by id (`useWorkstreamWithers`): only those with one. */
  withers: Readonly<Record<string, WorkstreamWither>>;
  proposals: readonly Proposal[];
  /** The cached tickets, for the unclear ones assigned to the person that have no workstream yet. */
  items: readonly WorkItem[];
  /** The signed-in person's accounts. */
  me: readonly PersonRef[];
  learning: ClarityLearning;
  now: Date;
}

export interface StartMyDay {
  lines: DayLine[];
  /** Nothing to start with: every line is empty. */
  empty: boolean;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The three groups' lines read: "2 to decide". */
const GROUP_TITLE: Record<NeedGroupKind, (n: number) => string> = {
  decide: (n) => `${n} to decide`,
  unblock: (n) => `${n} to unblock`,
  approve: (n) => `${n} to approve`,
};

const line = (kind: DayKind, title: (n: number) => string, entries: DayEntry[]): DayLine | null => (entries.length ? { kind, title: title(entries.length), count: entries.length, entries: entries.slice(0, DAY_ENTRIES), more: Math.max(0, entries.length - DAY_ENTRIES), rest: entries.slice(DAY_ENTRIES) } : null);

const isMine = (item: WorkItem, me: readonly PersonRef[]) => !!item.assignee && me.some((m) => m.connectionId === item.assignee!.connectionId && m.accountId === item.assignee!.accountId);

/** What a need is, in a few words: its ticket (General without one) and what it says. */
const needText = (n: Need) => `${n.ticketKey ?? "General"} · ${n.title}`;

/**
 * Whether the ticket is in the scope the unclear line looks at: assigned to the signed-in person. (A ticket's cache holds no
 * sprint, so "in an active sprint" can't be told; a ticket the person opened a workstream on explicitly is always in scope,
 * which `startMyDay` handles by taking every workstream's notice.)
 */
export const inClarityScope = isMine;

/**
 * The unclear tickets: every open workstream whose notice still names a gap the person hasn't taught away, then the person's own tickets with no workstream.
 * A ticket that already has a need is left out: it is listed under its Needs you group, and the need is the thing to do first.
 */
function unclearEntries(i: StartMyDayInput): DayEntry[] {
  const out: DayEntry[] = [];
  const opened = new Set<string>();
  const needWs = new Set(i.needs.flatMap((n) => (n.workstreamId ? [n.workstreamId] : [])));
  const needKeys = new Set(i.needs.flatMap((n) => (n.ticketKey ? [n.ticketKey] : [])));
  for (const v of i.workstreams) {
    const key = v.workstream.itemKey;
    if (!key || v.workstream.closedAt) continue;
    opened.add(`${v.workstream.connectionId}:${key}`);
    const gaps = flaggedGaps(v.clarity?.gaps ?? [], i.learning, projectOfKey(key));
    if (v.clarity && gaps.length && !needWs.has(v.workstream.id) && !needKeys.has(key)) out.push({ key: `unclear:${v.workstream.id}`, text: `${key} may be unclear: it ${gapsPhrase(gaps)}.`, label: "Open workstream", action: { type: "workstream", id: v.workstream.id } });
  }
  const own = i.items
    .filter((t) => t.status.category !== "done" && isMine(t, i.me) && !opened.has(`${t.item.connectionId}:${t.item.key}`) && !needKeys.has(t.item.key))
    .sort((a, b) => b.updated.localeCompare(a.updated))
    .flatMap((t): DayEntry[] => {
      const gaps: ClarityGap[] = flaggedGaps(clarityGaps(docText(t.body)), i.learning, projectOfKey(t.item.key));
      return gaps.length ? [{ key: `unclear:${t.item.key}`, text: `${t.item.key} may be unclear: it ${gapsPhrase(gaps)}.`, label: "Open ticket", action: { type: "ticket", key: t.item.key } }] : [];
    });
  return [...out, ...own];
}

/** The workstreams waiting on the reporter, longest first; one that waited long enough offers the nudge. */
function reporterEntries(i: StartMyDayInput): DayEntry[] {
  return i.workstreams
    .filter((v) => v.waitingOnReporter && !v.workstream.closedAt)
    .sort((a, b) => Date.parse(a.waitingOnReporter!.since) - Date.parse(b.waitingOnReporter!.since))
    .map((v) => {
      const days = waitedDays(v.waitingOnReporter!.since, i.now);
      const name = v.workstream.itemKey ?? v.workstream.title;
      const nudge = nudgeOffered(v.waitingOnReporter, i.now, i.proposals, v.workstream.id);
      const waited = days >= 1 ? `waiting ${plural(days, "day", "days")}` : "waiting since today";
      const drafted = i.proposals.some((p) => isReporterNudge(p) && p.state.type === "pending" && workstreamOf(p) === v.workstream.id);
      return {
        key: `reporter:${v.workstream.id}`,
        text: `${name} · ${waited}${drafted ? " · a nudge is drafted" : ""}`,
        label: nudge ? "Draft a nudge" : "Open workstream",
        action: nudge ? ({ type: "nudge", id: v.workstream.id } as const) : ({ type: "workstream", id: v.workstream.id } as const),
      };
    });
}

/** Workstreams that went quiet in Jira while work went on, the quietest first. A wait on the reporter has its own line. */
function cobwebEntries(i: StartMyDayInput): DayEntry[] {
  return i.workstreams
    .filter((v) => !v.workstream.closedAt && i.withers[v.workstream.id] && !i.withers[v.workstream.id].reporter)
    .sort((a, b) => i.withers[b.workstream.id].days - i.withers[a.workstream.id].days)
    .map((v) => ({ key: `cobweb:${v.workstream.id}`, text: `${v.workstream.itemKey ?? v.workstream.title} · no Jira update for ${plural(i.withers[v.workstream.id].days, "day", "days")}`, label: "Open workstream", action: { type: "workstream", id: v.workstream.id } as const }));
}

/** The Jira drafts waiting for the person, oldest first: each opens its own decision when Needs you has one, else its workstream or ticket. */
function draftEntries(i: StartMyDayInput): DayEntry[] {
  return i.proposals
    .filter((p) => p.state.type === "pending" && isJiraWrite(p.intent) && !p.supersededBy)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((p): DayEntry => {
      const target = targetOf(p.intent);
      const need = i.needs.find((n) => n.target.type === "draft" && n.target.id === p.id);
      const ws = i.workstreams.find((v) => inWorkstreamPane(p, v.workstream));
      const action: DayAction = need ? { type: "need", need } : ws ? { type: "workstream", id: ws.workstream.id } : { type: "ticket", key: target?.key ?? "" };
      return { key: `draft:${p.id}`, text: `${target?.key ?? "A new ticket"} · ${need?.title ?? WHAT[p.intent.type]}`, label: need ? "Review" : ws ? "Open workstream" : "Open ticket", action };
    });
}

const WHAT: Partial<Record<Proposal["intent"]["type"], string>> = { comment: "Draft comment", transition: "Draft move", subtasks: "Draft subtasks", create: "Draft ticket", link: "Draft link", update: "Draft change", rewrite: "Draft rewrite" };

/** What Start my day says now, line by line; a line with nothing in it is left out. */
export function startMyDay(i: StartMyDayInput): StartMyDay {
  const ranked = [...i.needs].sort(byRank);
  const groups = (["decide", "unblock", "approve"] as const).map((g) =>
    line(g, GROUP_TITLE[g], ranked.filter((n) => n.group === g).map((n): DayEntry => ({ key: n.key, text: needText(n), label: "Open", action: { type: "need", need: n } }))),
  );
  const lines = [
    ...groups,
    // The drafts wait on the person's click, so they come before the lines that only inform, and a short box does not cut them off.
    line("drafts", (n) => `${plural(n, "Jira draft", "Jira drafts")} waiting to be posted`, draftEntries(i)),
    line("unclear", (n) => `${plural(n, "ticket", "tickets")} may be unclear`, unclearEntries(i)),
    line("reporter", (n) => `${n} waiting on the reporter`, reporterEntries(i)),
    line("cobweb", (n) => `${plural(n, "workstream", "workstreams")} gone quiet in Jira`, cobwebEntries(i)),
  ].filter((l): l is DayLine => l !== null);
  return { lines, empty: lines.length === 0 };
}

/** Whether the card shows at `now`: not once the person pressed "Done for now" today. A day set later than today (a clock turned back) also holds it. */
export const startMyDayShown = (doneOn: string | null, now: Date) => !doneOn || doneOn < dayKey(now);
