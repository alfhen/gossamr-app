import type { Intent, Proposal, ProposalMaker, Run, RunKind, WorkstreamActor, WorkstreamEvent, WorkstreamView } from "../types";
import { eventText } from "../workspace/activityLogic";
import type { Need } from "./needs";
import { targetOf, workstreamOf } from "./proposals";

/**
 * One timeline per workstream (docs/needs-you.md, step 3): what Pip said, what the person said, each run from start to end
 * with its verdict, the drafts made and decided, pauses and undos, in one list, oldest first.
 * It reads what the stores already hold (the conversation's turns, the runs, the drafts, the workstream's audit and Needs
 * you) and decides nothing. A run is one entry, updated in place as it moves; a draft is one entry, which says how it was
 * decided; the audit lines that only repeat a run's or a draft's own story are left out.
 */

/** What an entry is: a question the person asked, a turn Pip took by itself (a wake), a run, a draft, or a line of the audit. */
export type TimelineKind = "said" | "pip" | "run" | "draft" | "audit";

/** The timeline's filters. Agents is `runs` across every workstream. */
export type TimelineFilter = "all" | "runs" | "drafts" | "decisions";

export const TIMELINE_FILTERS: readonly TimelineFilter[] = ["all", "runs", "drafts", "decisions"];

export const FILTER_LABEL: Record<TimelineFilter, string> = { all: "All", runs: "Runs", drafts: "Drafts", decisions: "Decisions" };

/**
 * What opening an entry shows: a run's sheet, a draft's card, or the need in Needs you's decision pane. An entry about
 * something waiting on the person always opens its need, the same as its row in Needs you. Null for an entry with
 * nothing more to show (a question and its answer, a line about the workstream itself).
 */
export type TimelineTarget = { type: "run"; id: string } | { type: "draft"; id: string } | { type: "need"; key: string } | null;

/** Where a run is in its life, as its one entry says it. */
export type RunPhase = "queued" | "started" | "waiting" | "finished" | "failed" | "stopped" | "limit" | "unknown";

export interface TimelineEntry {
  /** Stable across reads: `turn:<request id>`, `run:<id>`, `draft:<id>`, `audit:<workstream id>:<seq>`. */
  key: string;
  kind: TimelineKind;
  /**
   * When it happened, as an ISO time: a run's when it was approved or started by a rule (the audit's line, on the same
   * clock as the conversation), else when it was queued; a draft's when it was made.
   */
  at: string;
  /** When it last changed: a run's latest step, a decided draft's decision. Equal to `at` for the rest. */
  updatedAt: string;
  /** The ticket it is about, when there is one. */
  ticketKey: string | null;
  /** One short plain sentence. */
  text: string;
  /** What the sentence leaves to smaller type under it: a failed run's own message, as the run gave it. */
  detail?: string;
  target: TimelineTarget;
  /** The key of the need in Needs you this entry is about, while it waits on the person. */
  needKey: string | null;
  /** Something the person decided, or is asked to decide: what the Decisions filter shows. */
  decision: boolean;
  /** The turn's request id, for `said` and `pip`; for a draft Pip made answering a question, that question's. */
  turnId?: string;
  /** The run's id, for `run`. */
  runId?: string;
  /** For `run`: where it is now, and each step it took with when. */
  phase?: RunPhase;
  lifecycle?: { phase: RunPhase; at: string }[];
  /** For `draft`: its id and its state's kind. */
  draftId?: string;
  draftState?: Proposal["state"]["type"];
  /** For `audit`: who did it, what, and how many identical lines in a row it stands for. */
  actor?: WorkstreamActor;
  action?: string;
  count?: number;
}

/** The parts of a conversation's turn the timeline reads. `at` is when it was asked (or when Pip woke). */
export interface TimelineTurn {
  requestId: string;
  at?: string;
  kind?: "user" | "wake";
  prompt: string;
  shown?: string;
  text: string;
  status: "queued" | "running" | "done" | "failed";
}

export type ReviewOutcome = "pass" | "blocking" | null;

export interface TimelineInput {
  /** The conversation's turns, in the order they were asked. */
  turns?: readonly TimelineTurn[];
  /** The runs to show, already narrowed to the workstream (or to General's). */
  runs?: readonly Run[];
  /** The drafts to show, already narrowed the same way. */
  drafts?: readonly Proposal[];
  /** The workstream's audit, oldest first. */
  events?: readonly WorkstreamEvent[];
  /** Everything in Needs you; the entries about one of them link to it. */
  needs?: readonly Need[];
  /** The runs' short names in their workstream (`R1`), by id. */
  labels?: ReadonlyMap<string, string>;
  /** A finished review's verdict, by run id; absent while unread. */
  verdicts?: Readonly<Record<string, ReviewOutcome | undefined>>;
  /** The workstream's ticket, for the entries that name none of their own. */
  ticketKey?: string | null;
}

const KIND_WORD: Record<RunKind, string> = { investigate: "Investigate", triage: "Triage", plan: "Plan", build: "Build", review: "Review", verify: "Verify" };

/** What a draft is, in a few words: "a comment", "a move". */
const DRAFT_WORDS: Record<Intent["type"], string> = {
  comment: "a comment",
  transition: "a move",
  create: "a ticket",
  update: "a change",
  link: "a link",
  subtasks: "subtasks",
  rewrite: "a description update",
  startRun: "an agent run",
  followUp: "a follow-up",
  runAnswer: "an answer",
  githubReview: "a GitHub review",
};

const MAKER: Record<ProposalMaker, string> = { pip: "Pip", agent: "An agent", user: "You" };

/** The audit lines a run's or a draft's own entry already tells, or that are bookkeeping: left out. */
const TOLD_ELSEWHERE = new Set(["run_approved", "agent_started", "wake", "draft_created", "draft_retired", "notes_set"]);

/** Audit lines that ask the person to decide something, whoever wrote them. */
const ASKS = new Set(["paused", "pip_asked"]);

/** What the person did that counts as deciding something. Opening or closing a workstream and the notes are bookkeeping, not decisions. */
const DECIDED = new Set(["draft_approved", "draft_skipped", "review_posted", "paused", "resumed", "dismissed", "undone", "run_stopped", "run_answered", "run_retried", "pip_ask_cleared"]);

const time = (iso: string | undefined) => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : NaN;
};

const firstLine = (text: string | null | undefined) => text?.trim().split(/\n+/)[0]?.trim() ?? "";

/** Where a run is in its life, from its state. */
export function runPhase(run: Pick<Run, "state" | "stoppedByLimit">): RunPhase {
  switch (run.state) {
    case "queued":
      return "queued";
    case "launching":
    case "working":
      return "started";
    case "needsAnswer":
    case "needsPermission":
    case "systemBlocked":
      return "waiting";
    case "done":
      return "finished";
    case "failed":
      return "failed";
    case "stopped":
      return run.stoppedByLimit ? "limit" : "stopped";
    default:
      return "unknown";
  }
}

/** Each step of a run's life it has taken, with when: queued, started, and how it ended (or that it waits on the person now). */
export function runLifecycle(run: Run): { phase: RunPhase; at: string }[] {
  const out: { phase: RunPhase; at: string }[] = [{ phase: "queued", at: run.queuedAt }];
  if (run.launchedAt) out.push({ phase: "started", at: run.launchedAt });
  const now = runPhase(run);
  if (now === "waiting") out.push({ phase: "waiting", at: run.lastProgressAt });
  else if (now !== "queued" && now !== "started") out.push({ phase: now, at: run.endedAt ?? run.lastProgressAt });
  return out;
}

/**
 * The sentence a run's entry says: "Build R2 finished", "Review R3 finished: changes needed", "Plan R1 is waiting on you: it
 * asks a question". A failure is as short ("Build R2 failed"); what the run said went wrong is the entry's `detail`.
 */
export function runSentence(run: Run, label: string | undefined, verdict: ReviewOutcome | undefined): string {
  const name = `${KIND_WORD[run.spec.kind]}${label ? ` ${label}` : ""}`;
  switch (runPhase(run)) {
    case "queued":
      return `${name} queued`;
    case "started":
      return `${name} started`;
    case "waiting":
      return `${name} is waiting on you: ${run.state === "needsPermission" ? "it needs permission" : run.state === "systemBlocked" ? "sign in to Claude" : "it asks a question"}`;
    case "finished":
      return verdict === "pass" ? `${name} finished: the review passes` : verdict === "blocking" ? `${name} finished: changes needed` : `${name} finished`;
    case "failed":
      return `${name} failed`;
    case "stopped":
      return `${name} was stopped`;
    case "limit":
      return `${name} stopped at its limit`;
    default:
      return `${name}: Gossamr can't tell what it is doing`;
  }
}

/** Whose draft it was, for a sentence about the person's decision on it: "Pip", "an agent", "you". */
const makerWord = (p: Proposal) => (p.createdBy === "agent" ? "an agent" : p.createdBy === "user" ? "you" : MAKER[p.createdBy]);

/** What an applied draft says: the person's decision, and for a review or a run what it came to. */
function appliedSentence(p: Proposal, on: string): string {
  const i = p.intent;
  if (i.type === "githubReview") {
    const n = i.comments.length;
    return `You posted ${p.createdBy === "user" ? "your" : `${makerWord(p)}'s`} GitHub review on ${i.repo}#${i.number}: ${n} inline comment${n === 1 ? "" : "s"}${p.revisions.length ? ", edited by you" : ""}`;
  }
  if (i.type === "startRun") {
    const kind = KIND_WORD[i.spec.kind].toLowerCase();
    return `You started the ${kind} run that ${makerWord(p)} drafted${on}`;
  }
  return `You approved ${DRAFT_WORDS[i.type]}${on}${p.createdBy === "user" ? "" : `, drafted by ${makerWord(p)}`}: ${i.type === "runAnswer" ? "sent" : "posted"}`;
}

/** The sentence a draft's entry says: who made what on which ticket, then how it stands. */
export function draftSentence(p: Proposal): string {
  const target = targetOf(p.intent);
  const on = target ? ` on ${target.key}` : "";
  const made = `${MAKER[p.createdBy]} drafted ${DRAFT_WORDS[p.intent.type]}${on}`;
  switch (p.state.type) {
    case "pending":
      return made;
    case "applying":
      return `${made}: posting`;
    case "applied":
      return appliedSentence(p, on);
    case "skipped":
      return `${made}: skipped`;
    case "retired":
      return `${made}: ${p.supersededBy ? "replaced by a newer draft" : "no longer needed"}`;
  }
}

/** What a draft audit line says, naming the draft when it is on the timeline. */
function draftLine(e: WorkstreamEvent, who: string, draft: Proposal | undefined): string | null {
  const what = draft ? `${DRAFT_WORDS[draft.intent.type]}${targetOf(draft.intent) ? ` on ${targetOf(draft.intent)!.key}` : ""}` : "a draft";
  switch (e.action) {
    case "draft_approved":
      return `${who} approved ${what}`;
    case "draft_skipped":
      return `${who} skipped ${what}`;
    case "review_posted":
      return `${who} posted ${what}`;
    case "undone":
      return e.detail === "draft_skipped" ? `${who} brought back ${what}` : null;
    default:
      return null;
  }
}

const who = (actor: WorkstreamActor) => (actor === "person" ? "You" : actor === "pip" ? "Pip" : actor === "supervisor" ? "Gossamr" : "An agent");

/** Where entries of the same moment sort: what was said first, then what the audit says, then runs, then drafts. */
const SOURCE_RANK: Record<TimelineKind, number> = { said: 0, pip: 0, audit: 1, run: 2, draft: 3 };

/** An audit line about a draft (approved, skipped, a review posted) is what came of the draft, so it follows the draft at the same moment. */
const AFTER_DRAFT = SOURCE_RANK.draft + 0.5;

/**
 * The timeline: the conversation, the runs, the drafts and the audit merged into one list, oldest first. Entries at the
 * same moment keep their source's own order. A turn the page doesn't know the time of stands where the turn before it does.
 */
export function timeline(input: TimelineInput): TimelineEntry[] {
  const { turns = [], runs = [], drafts = [], events = [], needs = [], labels = new Map(), verdicts = {}, ticketKey = null } = input;
  const needOfRun = new Map(needs.flatMap((n) => (n.runId ? [[n.runId, n] as const] : [])));
  const needOfDraft = new Map(needs.flatMap((n) => (n.key.startsWith("draft:") ? [[n.key.slice("draft:".length), n] as const] : [])));
  const out: (TimelineEntry & { order: number; cause?: string })[] = [];
  let order = 0;

  // The conversation: a turn without a time stands with the one before it (or, first, the one after).
  const turnTimes = turns.map((t) => (Number.isFinite(time(t.at)) ? t.at! : null));
  for (let i = 0; i < turns.length; i++) {
    const t = turns[i];
    const at = turnTimes[i] ?? turnTimes.slice(0, i).reverse().find((x) => x !== null) ?? turnTimes.slice(i + 1).find((x) => x !== null) ?? "";
    const wake = t.kind === "wake";
    const said = (t.shown ?? t.prompt).trim();
    const text = wake ? (firstLine(t.text) ? `Pip: ${firstLine(t.text)}` : "Pip picked this up") : `You: ${firstLine(said)}`;
    out.push({ key: `turn:${t.requestId}`, kind: wake ? "pip" : "said", at, updatedAt: at, ticketKey, text, target: null, needKey: null, decision: false, turnId: t.requestId, order: order++ });
  }

  // A run enters the story when it was started, as the audit says; without such a line, when it was queued.
  const approvedAt = new Map<string, string>();
  for (const e of events) if (e.runId && (e.action === "run_approved" || e.action === "agent_started") && !approvedAt.has(e.runId)) approvedAt.set(e.runId, e.at);
  for (const run of runs) {
    const need = needOfRun.get(run.id);
    const lifecycle = runLifecycle(run);
    out.push({
      key: `run:${run.id}`,
      kind: "run",
      at: approvedAt.get(run.id) ?? run.queuedAt,
      updatedAt: lifecycle[lifecycle.length - 1].at,
      ticketKey: run.item?.key ?? ticketKey,
      text: runSentence(run, labels.get(run.id), verdicts[run.id]),
      ...(runPhase(run) === "failed" && firstLine(run.error) ? { detail: firstLine(run.error) } : {}),
      target: need ? { type: "need", key: need.key } : { type: "run", id: run.id },
      needKey: need?.key ?? null,
      decision: !!need,
      runId: run.id,
      phase: runPhase(run),
      lifecycle,
      order: order++,
    });
  }

  for (const p of drafts) {
    const need = needOfDraft.get(p.id);
    out.push({
      key: `draft:${p.id}`,
      kind: "draft",
      at: p.createdAt,
      updatedAt: p.state.type === "pending" ? p.createdAt : p.updatedAt,
      ticketKey: targetOf(p.intent)?.key ?? ticketKey,
      text: draftSentence(p),
      target: need ? { type: "need", key: need.key } : { type: "draft", id: p.id },
      needKey: need?.key ?? null,
      decision: !!need,
      draftId: p.id,
      draftState: p.state.type,
      ...(p.origin.type === "chat" ? { turnId: p.origin.requestId } : {}),
      // A draft a run left is what came of it.
      ...(p.origin.type === "run" ? { cause: `run:${p.origin.runId}` } : {}),
      order: order++,
    });
  }

  // The audit: worded as the Activity feed words it, less what a run's or a draft's own entry already tells.
  const byDraft = new Map(drafts.map((p) => [p.id, p]));
  const label = (id: string | null) => (id ? (labels.get(id) ?? `run ${id.length <= 12 ? id : id.slice(0, 8)}`) : "a run");
  const lastPaused = [...events].reverse().find((e) => e.action === "paused" || e.action === "held" || e.action === "resumed");
  const pausedNeed = needs.find((n) => n.kind === "paused");
  let previous: (TimelineEntry & { order: number; cause?: string }) | null = null;
  for (const e of events) {
    if (TOLD_ELSEWHERE.has(e.action)) continue;
    const draft = e.proposalId ? byDraft.get(e.proposalId) : undefined;
    // An approval, or a review posted, that its draft's own entry already says ("You approved a comment: posted") is that entry's.
    if (draft && (e.action === "draft_approved" || e.action === "review_posted") && (draft.state.type === "applied" || draft.state.type === "applying")) {
      const entry = out.find((x) => x.key === `draft:${draft.id}`);
      if (entry) {
        if (e.actor === "person") entry.decision = true;
        continue;
      }
    }
    const text = (e.proposalId ? draftLine(e, who(e.actor), draft) : null) ?? eventText(e, label);
    if (!text) continue;
    // A line about something still waiting on the person opens its need: the pause that still holds.
    const need = (e.action === "paused" || e.action === "held") && e === lastPaused && pausedNeed ? pausedNeed : e.runId ? needOfRun.get(e.runId) : undefined;
    const target: TimelineTarget = need ? { type: "need", key: need.key } : e.proposalId && draft ? { type: "draft", id: e.proposalId } : e.runId && runs.some((r) => r.id === e.runId) ? { type: "run", id: e.runId } : null;
    // The same line again and again is one entry that says how many.
    if (previous && previous.text.replace(/ \(\d+ times\)$/, "") === text && previous.actor === e.actor && previous.action === e.action && !need) {
      previous.count = (previous.count ?? 1) + 1;
      previous.text = `${text} (${previous.count} times)`;
      previous.updatedAt = e.at;
      continue;
    }
    const entry: TimelineEntry & { order: number; cause?: string } = {
      key: `audit:${e.workstreamId}:${e.seq}`,
      kind: "audit",
      at: e.at,
      updatedAt: e.at,
      ticketKey,
      text,
      target,
      needKey: need?.key ?? null,
      decision: (e.actor === "person" && DECIDED.has(e.action)) || ASKS.has(e.action) || !!need,
      actor: e.actor,
      action: e.action,
      ...(e.proposalId && draft ? { cause: `draft:${e.proposalId}` } : {}),
      order: order++,
    };
    out.push(entry);
    previous = entry;
  }

  // When things happened, except that an effect never stands before its cause: a draft a run left, or what was done to a
  // draft, is not earlier than the run, or the draft, it came of, whatever the clocks the stores read say.
  const placed = new Map<string, { t: number; rank: number }>();
  const place = (e: TimelineEntry & { cause?: string }) => {
    const own = { t: when(e), rank: SOURCE_RANK[e.kind] };
    const cause = e.cause ? placed.get(e.cause) : undefined;
    placed.set(e.key, cause ? { t: Math.max(own.t, cause.t), rank: e.kind === "audit" ? AFTER_DRAFT : own.rank } : own);
  };
  // Causes first: runs, then drafts, then the lines about drafts and everything else.
  for (const kind of ["run", "draft"] as const) for (const e of out) if (e.kind === kind) place(e);
  for (const e of out) if (e.kind !== "run" && e.kind !== "draft") place(e);
  return out
    .sort((a, b) => {
      const x = placed.get(a.key)!;
      const y = placed.get(b.key)!;
      return compare(x.t, y.t) || x.rank - y.rank || a.order - b.order;
    })
    .map(({ order: _order, cause: _cause, ...e }) => e);
}

const compare = (a: number, b: number) => (a < b ? -1 : a > b ? 1 : 0);

/** An entry with no time sorts first, as the oldest it could be. */
const when = (e: { at: string }) => {
  const t = time(e.at);
  return Number.isFinite(t) ? t : -Infinity;
};

/**
 * The drafts a conversation's timeline shows. A workstream's are the ones its conversation shows (`proposals`, already
 * narrowed); General's are those in no workstream, the ones Pip made answering here, and every one still waiting, as
 * General's "Drafts waiting" listed them.
 */
export function timelineDrafts(proposals: readonly Proposal[], workstream: boolean, asked: ReadonlySet<string>): Proposal[] {
  if (workstream) return [...proposals];
  return proposals.filter((p) => workstreamOf(p) === null || (p.origin.type === "chat" && asked.has(p.origin.requestId)) || p.state.type === "pending" || p.state.type === "applying");
}

/** The runs a conversation's timeline shows: a workstream's own, or, in General, those in no workstream. */
export function timelineRuns(runs: readonly Run[], view: WorkstreamView | null): Run[] {
  if (!view) return runs.filter((r) => !r.spec.workstream);
  return runs.filter((r) => view.runs.includes(r.id) || r.spec.workstream === view.workstream.id);
}

/** Whether filter `f` shows entry `e`. */
export function shows(f: TimelineFilter, e: Pick<TimelineEntry, "kind" | "decision">): boolean {
  switch (f) {
    case "all":
      return true;
    case "runs":
      return e.kind === "run";
    case "drafts":
      return e.kind === "draft";
    case "decisions":
      return e.decision;
  }
}

/** The entries filter `f` shows, in the same order. */
export const filterTimeline = (entries: readonly TimelineEntry[], f: TimelineFilter): TimelineEntry[] => entries.filter((e) => shows(f, e));

/** How many entries each filter shows, for the filter's buttons. */
export function filterCounts(entries: readonly TimelineEntry[]): Record<TimelineFilter, number> {
  return Object.fromEntries(TIMELINE_FILTERS.map((f) => [f, entries.filter((e) => shows(f, e)).length])) as Record<TimelineFilter, number>;
}

/** What a filter with nothing to show says. */
export const EMPTY_FILTER: Record<TimelineFilter, string> = {
  all: "Nothing has happened here yet.",
  runs: "No runs here yet.",
  drafts: "No drafts here yet.",
  decisions: "Nothing decided here yet, and nothing waits on you.",
};
