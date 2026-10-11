import { keysIn } from "../lib/devLinks";
import { safeGithubUrl } from "../lib/githubUrl";
import type { ContainerRef, FeedEntry, FeedQuery, ItemRef, PersonRef, Proposal, Run, WorkEvent, WorkstreamActor, WorkstreamEvent, WorkstreamView } from "../types";
import { targetOf } from "../lib/proposals";
import { itemKey } from "../lib/filter";
import type { WorkItem } from "../types";
import { KIND_LABEL, permissionRequest, resultHeadline } from "./agentsLogic";

export const CHIPS = ["all", "needsMe", "mentions", "comments", "status", "assigned", "drafts"] as const;
/** The chip that shows what Pip and the agents did in the workstreams, from their audit; offered only while Agents are on. */
export const PIP_CHIP = "pip";
export type ActivityChip = (typeof CHIPS)[number] | typeof PIP_CHIP;

/** The chips to offer: every one in `CHIPS`, then "Pip & agents" while Agents are on. */
export const chipsFor = (o: { agents: boolean }): readonly ActivityChip[] => (o.agents ? [...CHIPS, PIP_CHIP] : CHIPS);

export const CHIP_LABEL: Record<ActivityChip, string> = {
  pip: "Pip & agents",
  all: "All",
  needsMe: "Needs me",
  mentions: "Mentions",
  comments: "Comments",
  status: "Status changes",
  assigned: "Assigned to me",
  drafts: "Drafts",
};

/** Needs me is what is still unread: the inbox marks an event read once it has been dealt with. */
export function queryFor(chip: ActivityChip, container: ContainerRef | null): FeedQuery {
  const base: FeedQuery = { container };
  switch (chip) {
    case "needsMe":
      return { ...base, unreadOnly: true };
    case "mentions":
      return { ...base, mentionsOnly: true };
    case "comments":
      return { ...base, kinds: ["commentAdded"] };
    case "status":
      return { ...base, kinds: ["statusChanged"] };
    case "assigned":
      return { ...base, kinds: ["assigned"] };
    default:
      return base;
  }
}

export interface DayGroup<T extends { at: string } = FeedEntry> {
  /** Local calendar day, `YYYY-MM-DD`. */
  day: string;
  label: string;
  entries: T[];
}

const dayKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

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

/** Pending drafts, narrowed to a project when there is one. Drafts about nothing in the cache stay in only when unfiltered. */
export function draftsFor(pending: readonly Proposal[], items: Record<string, WorkItem>, container: ContainerRef | null): Proposal[] {
  if (!container) return [...pending];
  return pending.filter((p) => {
    const target = targetOf(p.intent);
    const item = target ? items[itemKey(target)] : undefined;
    return item?.container.externalId === container.externalId && item.container.connectionId === container.connectionId;
  });
}

/** The index j and k move to, staying inside the list. -1 means nothing is active yet. */
export const stepIndex = (current: number, delta: 1 | -1, length: number): number =>
  length === 0 ? -1 : Math.min(length - 1, Math.max(0, current < 0 ? (delta === 1 ? 0 : length - 1) : current + delta));

export const SOURCES = ["all", "jira", "github", "agents"] as const;
export type ActivitySource = (typeof SOURCES)[number];

export const SOURCE_LABEL: Record<ActivitySource, string> = { all: "All sources", jira: "Jira", github: "GitHub", agents: "Agents" };

/** The source to show: the chosen one while it is offered, else the tracker's. */
export const shownSourceOf = (source: ActivitySource, offered: readonly ActivitySource[]): ActivitySource => (offered.includes(source) ? source : "jira");

/** Whether a source's "Mark all read" is about agent entries. */
export const coversAgents = (source: ActivitySource) => source === "all" || source === "agents";

/** The sources worth offering: the tracker always, GitHub once connected, Agents while they are on. */
export const sourcesFor = (o: { github: boolean; agents: boolean }): ActivitySource[] => ["all", "jira", ...(o.github ? (["github"] as const) : []), ...(o.agents ? (["agents"] as const) : [])];

/** A GitHub event as a row of the feed. `item` is the ticket it belongs to when one is known. */
export interface CodeEntry {
  source: "github";
  id: string;
  at: string;
  kind: WorkEvent["kind"];
  connectionId: string;
  actor: PersonRef | null;
  repo: string;
  number: number | null;
  title: string;
  text: string;
  url: string | null;
  item: ItemRef | null;
  mention: boolean;
  /** Something the person is asked to do or ought to see: a review to give, a check to fix, a mention, a verdict on their pull request. */
  needsYou: boolean;
  unread: boolean;
}

export type RunEntryKind = "started" | "needsYou" | "finished" | "failed";

/** An agent run as a row of the feed: it started, wants the person, finished or failed. */
export interface RunEntry {
  source: "agents";
  /** `run:<run id>:<what>`, the same for the same thing however often the run is read, so read marks stick. */
  id: string;
  at: string;
  kind: RunEntryKind;
  runId: string;
  item: ItemRef | null;
  text: string;
  mention: false;
  needsYou: boolean;
  unread: boolean;
}

/** A line of a workstream's audit as a row of the feed: "Pip picked up R2", "Triage started automatically after R1". */
export interface WorkstreamEntry {
  source: "pip";
  /** `ws:<workstream id>:<seq>`, one per audit line. */
  id: string;
  at: string;
  workstreamId: string;
  actor: WorkstreamActor;
  action: string;
  runId: string | null;
  /** The workstream's ticket by key, null for a ticketless one; `item` is the ticket itself when the page knows it. */
  itemKey: string | null;
  item: ItemRef | null;
  text: string;
  mention: false;
  unread: false;
}

/** One row of the merged feed. */
export type ActivityRow = { source: "jira"; entry: FeedEntry } | { source: "github"; entry: CodeEntry } | { source: "agents"; entry: RunEntry } | { source: "pip"; entry: WorkstreamEntry };

export const rowId = (r: ActivityRow) => r.entry.id;
export const rowAt = (r: ActivityRow) => r.entry.at;

const NEEDS_YOU = new Set<WorkEvent["kind"]>(["reviewRequested", "checkFailed", "prMentioned", "assigned", "reviewSubmitted"]);

/** Events this old no longer ask for attention, since nothing tells the app they were dealt with on GitHub. */
export const CODE_UNREAD_DAYS = 14;

export const needsYou = (kind: WorkEvent["kind"]) => NEEDS_YOU.has(kind);

/** Nothing on the wire says a GitHub event was read, so the page remembers which ones the person opened or marked. */
export const isCodeUnread = (e: Pick<WorkEvent, "id" | "kind" | "at">, read: ReadonlySet<string>, now: number) =>
  needsYou(e.kind) && now - Date.parse(e.at) < CODE_UNREAD_DAYS * 864e5 && !read.has(e.id);

export const codeEventUnread = (events: readonly WorkEvent[], read: ReadonlySet<string>, now: number) =>
  events.filter((e) => e.subject.type === "codeChange" && isCodeUnread(e, read, now)).length;

const payloadOf = (e: WorkEvent): Record<string, unknown> => (e.payload && typeof e.payload === "object" ? (e.payload as Record<string, unknown>) : {});

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/** The GitHub page of a change, from the event when it says, else built from its repository and number. */
export function codeUrl(repo: string, number: number | null, url: string | null): string | null {
  const given = url && safeGithubUrl(url);
  if (given) return given;
  return number && /^[\w.-]+\/[\w.-]+$/.test(repo) ? `https://github.com/${repo}/pull/${number}` : null;
}

export interface CodeContext {
  /** Tickets by key, upper case, in the cache. */
  byKey: ReadonlyMap<string, ItemRef>;
  /** Tickets known to be linked to a change, by the change's id. */
  byChange: ReadonlyMap<string, ItemRef>;
  read: ReadonlySet<string>;
  now: number;
}

/** The ticket a change belongs to: a link already read, else a ticket key in its title that is in the cache. */
export function ticketOfChange(repo: string, number: number | null, title: string, ctx: Pick<CodeContext, "byKey" | "byChange">): ItemRef | null {
  const linked = number === null ? undefined : ctx.byChange.get(`pr:${repo}#${number}`);
  if (linked) return linked;
  for (const k of keysIn(title)) {
    const hit = ctx.byKey.get(k);
    if (hit) return hit;
  }
  return null;
}

export function toCodeEntry(e: WorkEvent, ctx: CodeContext): CodeEntry | null {
  if (e.subject.type !== "codeChange") return null;
  const p = payloadOf(e);
  const { repo, number } = e.subject;
  const n = number || null;
  const title = str(p.title) ?? "";
  return {
    source: "github",
    id: e.id,
    at: e.at,
    kind: e.kind,
    connectionId: e.connectionId,
    actor: e.actor,
    repo,
    number: n,
    title,
    text: str(p.text) ?? `${repo}${n ? `#${n}` : ""}: ${title}`,
    url: codeUrl(repo, n, str(p.url)),
    item: ticketOfChange(repo, n, title, ctx),
    mention: p.mention === true,
    needsYou: needsYou(e.kind),
    unread: isCodeUnread(e, ctx.read, ctx.now),
  };
}

/** Whether a chip of the feed shows a GitHub entry. Comments and status changes are the tracker's alone. */
export function codeMatchesChip(chip: ActivityChip, e: Pick<CodeEntry, "kind" | "mention" | "unread">): boolean {
  switch (chip) {
    case "all":
      return true;
    case "needsMe":
      return e.unread;
    case "mentions":
      return e.mention;
    case "assigned":
      return e.kind === "assigned";
    case "comments":
    case "status":
    case "drafts":
    case "pip":
      return false;
  }
}

const firstLine = (text: string | null) => text?.trim().split(/\n+/)[0]?.trim() ?? "";

function attention(run: Run, drafted: boolean, breakdown: boolean): { kind: RunEntryKind; what: string; at: string; text: string } | null {
  const kind = KIND_LABEL[run.spec.kind];
  switch (run.state) {
    case "needsAnswer":
      return { kind: "needsYou", what: "needsAnswer", at: run.lastProgressAt, text: `${kind} agent is asking you: ${firstLine(run.needs) || "it is waiting for you"}` };
    case "needsPermission":
      return { kind: "needsYou", what: "needsPermission", at: run.lastProgressAt, text: `${kind} agent needs permission: ${permissionRequest(run.needs)?.command ?? "it is waiting for you"}` };
    case "systemBlocked":
      return { kind: "needsYou", what: "systemBlocked", at: run.lastProgressAt, text: `${kind} agent is waiting: Claude needs you to sign in` };
    case "done":
      return {
        kind: "finished",
        what: "done",
        at: run.endedAt ?? run.lastProgressAt,
        text: `${breakdown && run.item ? `Breakdown proposed on ${run.item.key}. ` : drafted && run.item ? `Draft ready on ${run.item.key}. ` : ""}${kind} agent finished: ${resultHeadline(run.summary ?? run.result) ?? "it wrote no answer"}`,
      };
    case "failed":
      return { kind: "failed", what: "failed", at: run.endedAt ?? run.lastProgressAt, text: `${kind} agent failed: ${firstLine(run.error) || "no reason was recorded"}` };
    default:
      return null;
  }
}

/** The rows runs add to the feed, newest first. Only what is true now is listed; an entry that stopped being true leaves. */
export function toRunEntries(runs: readonly Run[], read: ReadonlySet<string>, now: number, drafted: ReadonlySet<string> = new Set(), breakdown: ReadonlySet<string> = new Set()): RunEntry[] {
  const seen = new Set<string>();
  const out: RunEntry[] = [];
  const add = (e: Omit<RunEntry, "source" | "mention" | "unread" | "needsYou"> & { watch: boolean }) => {
    if (seen.has(e.id)) return;
    seen.add(e.id);
    const { watch, ...rest } = e;
    out.push({ ...rest, source: "agents", mention: false, needsYou: watch, unread: watch && now - Date.parse(e.at) < CODE_UNREAD_DAYS * 864e5 && !read.has(e.id) });
  };
  for (const run of runs) {
    if (run.launchedAt && run.shortId) add({ id: `run:${run.id}:started`, at: run.launchedAt, kind: "started", runId: run.id, item: run.item, text: `${KIND_LABEL[run.spec.kind]} agent started`, watch: false });
    const now_ = attention(run, drafted.has(run.id), breakdown.has(run.id));
    if (now_) add({ id: `run:${run.id}:${now_.what}`, at: now_.at, kind: now_.kind, runId: run.id, item: run.item, text: now_.text, watch: true });
  }
  return out.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.id.localeCompare(b.id)));
}

/** Whether a chip of the feed shows an agent entry. Only the tracker has comments and status changes. */
export function agentMatchesChip(chip: ActivityChip, e: Pick<RunEntry, "unread">): boolean {
  return chip === "all" || (chip === "needsMe" && e.unread);
}

const KIND_WORD: Record<string, string> = { investigate: "Investigate", triage: "Triage", plan: "Plan", build: "Build", review: "Review", verify: "Verify" };

const HELD_WORDS: Record<WorkstreamActor, string> = { person: "You held the workstream", pip: "Pip held the workstream", supervisor: "The workstream was held", run: "The workstream was held" };

/**
 * What one audit line says in the feed, naming runs by their label in the workstream (`label`); null for lines the
 * feed leaves out (a fix round's own auto-start line, which "Fix round n sent" already says, and bookkeeping).
 * `rounds` counts the fix rounds sent so far, this one included.
 */
function eventText(e: WorkstreamEvent, label: (id: string | null) => string, rounds: number): string | null {
  const who = e.actor === "person" ? "You" : e.actor === "pip" ? "Pip" : e.actor === "supervisor" ? "Gossamr" : "An agent";
  switch (e.action) {
    case "opened":
      return `${who} opened the workstream`;
    case "closed":
      return `${who} closed the workstream`;
    case "wake":
      return `Pip picked up ${label(e.runId)}`;
    case "autostart": {
      const [rule, after] = (e.detail ?? "").split(" after ");
      if (rule === "fix_round") return null;
      const kind = KIND_WORD[rule?.split("_")[1] ?? ""] ?? "The next step";
      return `${kind} ${label(e.runId)} started automatically${after ? ` after ${label(after)}` : ""}`;
    }
    case "autostart_failed":
      return `An automatic step after ${label(e.runId)} couldn't start`;
    case "fix_round_sent":
      return `Fix round ${rounds} sent to ${label(e.runId)}`;
    case "fix_rounds_exhausted":
      return `The review still blocks after ${e.detail ?? "2"} fix rounds`;
    case "waiting_for_pr":
      return `${label(e.runId)} is waiting for its pull request`;
    case "held":
      return HELD_WORDS[e.actor];
    case "resumed":
      return `${who} resumed the workstream`;
    case "mode_set":
      return e.detail === "manage" ? `${who} let Pip manage the workstream` : `${who} stopped Pip managing the workstream`;
    case "rule_set":
      return `${who} changed an automatic step`;
    case "run_approved":
      return `${who} started ${label(e.runId)}`;
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
    case "notes_set":
      return "Pip updated its notes";
    case "budget_reset":
      return `${who} reset the budget`;
    default:
      return null;
  }
}

/**
 * The rows the workstreams' audits add to the "Pip & agents" chip, newest first: each line of `events` (by workstream,
 * oldest first in each) worded for the feed, with its workstream's ticket as the item. `refOf` finds the ticket itself
 * when the page knows it, for narrowing to a project.
 */
export function toWorkstreamEntries(events: Readonly<Record<string, readonly WorkstreamEvent[]>>, workstreams: readonly WorkstreamView[], refOf: (ws: WorkstreamView) => ItemRef | null = () => null): WorkstreamEntry[] {
  const out: WorkstreamEntry[] = [];
  for (const view of workstreams) {
    const id = view.workstream.id;
    const labels = new Map(view.labels);
    const label = (run: string | null) => (run ? (labels.get(run) ?? `run ${run.length <= 12 ? run : run.slice(0, 8)}`) : "a run");
    const item = refOf(view);
    let rounds = 0;
    for (const e of events[id] ?? []) {
      if (e.action === "fix_round_sent") rounds++;
      const text = eventText(e, label, rounds);
      if (!text) continue;
      out.push({ source: "pip", id: `ws:${id}:${e.seq}`, at: e.at, workstreamId: id, actor: e.actor, action: e.action, runId: e.runId, itemKey: view.workstream.itemKey, item, text, mention: false, unread: false });
    }
  }
  return out.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : b.id.localeCompare(a.id, undefined, { numeric: true })));
}

export interface RowsInput {
  source: ActivitySource;
  chip: ActivityChip;
  container: ContainerRef | null;
  jira: readonly FeedEntry[];
  /** More Jira entries follow the loaded ones; GitHub entries older than the last loaded one then wait for them. */
  more: boolean;
  code: readonly CodeEntry[];
  agents?: readonly RunEntry[];
  /** The workstreams' audit lines, shown under the "Pip & agents" chip and nowhere else. */
  workstream?: readonly WorkstreamEntry[];
  /** The container an item is in, to narrow GitHub entries to a project through their ticket. */
  containerOf(item: ItemRef): ContainerRef | null;
}

const sameContainer = (a: ContainerRef, b: ContainerRef) => a.connectionId === b.connectionId && a.externalId === b.externalId;

/** The feed the person sees: each source filtered by the chip and project, newest first. "Pip & agents" is the workstreams' audit alone. */
export function buildRows(i: RowsInput): ActivityRow[] {
  if (i.chip === PIP_CHIP) {
    return (i.workstream ?? [])
      .filter((e) => !i.container || (!!e.item && sameContainer(i.containerOf(e.item) ?? { connectionId: "", externalId: "" }, i.container)))
      .map((entry): ActivityRow => ({ source: "pip", entry }))
      .sort((a, b) => (rowAt(a) < rowAt(b) ? 1 : rowAt(a) > rowAt(b) ? -1 : rowId(b).localeCompare(rowId(a), undefined, { numeric: true })));
  }
  const jira: ActivityRow[] = i.source === "github" || i.source === "agents" ? [] : i.jira.map((entry) => ({ source: "jira", entry }));
  const oldest = i.more && i.jira.length ? i.jira[i.jira.length - 1].at : null;
  const code: ActivityRow[] =
    i.source === "jira" || i.source === "agents"
      ? []
      : i.code
          .filter((e) => codeMatchesChip(i.chip, e))
          .filter((e) => !i.container || (!!e.item && sameContainer(i.containerOf(e.item) ?? { connectionId: "", externalId: "" }, i.container)))
          .filter((e) => i.source === "github" || oldest === null || e.at >= oldest)
          .map((entry) => ({ source: "github", entry }));
  const agents: ActivityRow[] =
    i.source === "jira" || i.source === "github"
      ? []
      : (i.agents ?? [])
          .filter((e) => agentMatchesChip(i.chip, e))
          .filter((e) => !i.container || (!!e.item && sameContainer(i.containerOf(e.item) ?? { connectionId: "", externalId: "" }, i.container)))
          .filter((e) => i.source === "agents" || oldest === null || e.at >= oldest)
          .map((entry) => ({ source: "agents", entry }));
  return [...jira, ...code, ...agents].sort((a, b) => (rowAt(a) < rowAt(b) ? 1 : rowAt(a) > rowAt(b) ? -1 : rowId(a).localeCompare(rowId(b))));
}


export function codeVerb(kind: WorkEvent["kind"]): string {
  switch (kind) {
    case "prOpened":
      return "Pull request opened";
    case "prMerged":
      return "Pull request merged";
    case "prClosed":
      return "Pull request closed";
    case "prReadyForReview":
      return "Ready for review";
    case "reviewRequested":
      return "Review requested";
    case "reviewSubmitted":
      return "Review submitted";
    case "checkFailed":
      return "Checks failed";
    case "prMentioned":
      return "You were mentioned";
    case "assigned":
      return "Assigned to you";
    default:
      return "Pull request activity";
  }
}
