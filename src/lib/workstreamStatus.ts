import type { Proposal, Run, WorkstreamEvent, WorkstreamView } from "../types";
import { flaggedGaps, projectOfKey, type ClarityLearning } from "./clarityLearning";
import { needsIn, type Need } from "./needs";
import { workstreamOf } from "./proposals";
import { NUDGE_AFTER_DAYS, WAITING_STATUS, answersDue, waitedDays } from "./reporterWait";
import { isHeldByYou, shortHeld } from "./workstreamHold";
import { STAGE_LABEL } from "./workstreamStage";
import { witherShort, type WorkstreamWither } from "./workstreamWither";

/**
 * One status word per workstream, the first of these that applies. The order is the one docs/needs-you.md gives its
 * questions, most to least urgent, so the word is always the thing to do or know first:
 *
 * 1. `needs-you`: something in this workstream waits on the person. It outranks everything because Needs you is the one
 *    place decisions are made, a hold the system made is itself a need (so a restart or a tripwire reads "Needs you", and
 *    its reason is the detail when it is the only need: "Held: the ticket was moved to Done"), and a person who has one thing to do must not be
 *    told the workstream is merely "Running". "Held" is left for a hold that asks nothing: the person's own.
 * 2. `held`: no wakes and no automatic steps. A hold the person chose is no need, so it comes next: it is the reason
 *    nothing is moving, and reads "Held by you".
 * 3. `waiting`: asked the reporter; nothing starts on its own until they answer. Above Running because a run that is
 *    still finishing doesn't change what the workstream is waiting for.
 * 4. `running`: a run is active (or queued for a slot).
 * 5. `quiet`: nothing has happened for a while, or the cobweb has grown ("work is happening but Jira hasn't heard").
 *    Never for a closed workstream.
 * 6. `done`: closed, or its stage is done.
 * 7. `idle`: none of the above. A word-check notice ("may be unclear", `view.clarity`) is not a need, so it stays Idle and says so in
 *    the detail: the pill agrees with Needs you, which counts nothing for it.
 *
 * Pure: `now`, the runs, the cobweb and the quiet limit are given.
 */
export type StatusState = "needs-you" | "held" | "waiting" | "running" | "quiet" | "done" | "idle";

/** The states from most to least urgent: the order `workstreamStatus` picks in, and the order a filter lists them. */
export const STATUS_ORDER: readonly StatusState[] = ["needs-you", "held", "waiting", "running", "quiet", "done", "idle"];

/** How far down the workstream list a state sits: what needs the person first, then what is held or waits on someone else, then what moves, then what does not. Held and Waiting on reporter share a rank (the person's own hold comes after them: `byStatusRank`). */
const LIST_RANK: Record<StatusState, number> = { "needs-you": 0, held: 1, waiting: 1, running: 2, idle: 3, quiet: 4, done: 5 };

/** Where the person's own hold sits: under the holds the system made (they ask something of the person), before what is running. */
const HELD_BY_YOU_RANK = 1.5;

/**
 * The workstreams in the order the list shows them: by their status (Needs you, then Held by the system and Waiting on
 * reporter, then Held by you, then Running, then Idle, Quiet and Done), each group in the order it was given (newest first, as
 * the store keeps them). `heldByYou` tells the person's own hold from one the system made; without it every hold is the system's.
 * Pure and stable; `items` is left as it is.
 */
export function byStatusRank<T>(items: readonly T[], stateOf: (item: T) => StatusState, heldByYou: (item: T) => boolean = () => false): T[] {
  const rankOf = (item: T) => {
    const state = stateOf(item);
    return state === "held" && heldByYou(item) ? HELD_BY_YOU_RANK : LIST_RANK[state];
  };
  return items.map((item, at) => ({ item, at, rank: rankOf(item) })).sort((a, b) => a.rank - b.rank || a.at - b.at).map((x) => x.item);
}

/** Colour tokens a state is drawn with (`ws-*` in theme.css); `ink` is the quiet grey. */
export type StatusTone = "pip" | "warn" | "review" | "accent" | "ink" | "done";

export const STATUS_TONE: Record<StatusState, StatusTone> = { "needs-you": "pip", held: "warn", waiting: "review", running: "accent", quiet: "ink", done: "done", idle: "ink" };

/** The words a state is shown with; a hold the person chose says so ("Held by you"). */
export const STATUS_WORD: Record<StatusState, string> = { "needs-you": "Needs you", held: "Held", waiting: "Waiting on reporter", running: "Running", quiet: "Quiet", done: "Done", idle: "Idle" };

/** What each word means, for the pill's tooltip and the glossary: what is going on, and what ends it. */
export const STATUS_HINT: Record<StatusState, string> = {
  "needs-you": "Something in this workstream waits on a decision from you. Open it in Needs you.",
  held: "No wakes and no automatic steps until the hold is lifted: Resume it when you are ready.",
  waiting: `You asked the reporter on the ticket. A comment there ends the wait; after ${NUDGE_AFTER_DAYS} days Gossamr offers a nudge.`,
  running: "A Claude Code run is working on a step, or is queued for a slot.",
  quiet: "Nothing has happened for a while, or work is happening that Jira has not heard about.",
  done: "The workstream is closed, or its work is finished.",
  idle: "Nothing is running and nothing waits on you: nothing has started yet, or the last step finished. \"may be unclear\" is a quick check of the ticket's words, not a decision waiting for you.",
};

/** What the list says when a status filter matches no workstream. */
export const EMPTY_FILTER: Record<StatusState, string> = {
  "needs-you": "No workstream needs you.",
  held: "No workstream is held.",
  waiting: "No workstream is waiting on the reporter.",
  running: "No workstream is running.",
  quiet: "No workstream is quiet.",
  done: "No workstream is done.",
  idle: "No workstream is idle.",
};

/**
 * What the list says when the `state` filter matches no workstream. Runs that belong to General are no workstream's, so for
 * Running it adds where they are: "No workstream is running. 2 agents are running under General."
 */
export function emptyFilterText(state: StatusState, generalRunning = 0): string {
  const base = EMPTY_FILTER[state];
  if (state !== "running" || generalRunning <= 0) return base;
  return `${base} ${generalRunning === 1 ? "1 agent is" : `${generalRunning} agents are`} running under General.`;
}

export interface WorkstreamStatus {
  state: StatusState;
  /** The one word: "Needs you", "Held by you", "Waiting on reporter". */
  word: string;
  tone: StatusTone;
  /** At most one short detail after the word: "asked 3 days ago", "2 waiting", "Build", "automatic steps used up"; null when the word says it all. */
  detail: string | null;
}

export interface StatusMore {
  /** Every run; those of the workstream are read from `view.runs`. */
  runs?: readonly Run[];
  /** The workstream's cobweb (`useWorkstreamWithers`), when it has one. */
  wither?: WorkstreamWither | null;
  now?: Date;
  /** Days without a run or a post before a workstream with no cobweb reads Quiet. */
  quietDays?: number;
  /** What "Looks fine" taught the clarity notice: a notice with nothing left to say is not one. */
  learning?: ClarityLearning;
  /** The person chose "I'll answer" and has not drafted their answers since (`answersOwed`): the detail says the answers are theirs to give. */
  answersOwed?: boolean;
}

/** What the pill adds to a detail when the workstream also waits on someone: "waiting on reporter", "your answers owed". */
export const OWED_DETAIL = "your answers owed";
export const ON_REPORTER_DETAIL = "waiting on reporter";

/** Whether the person owes answers in workstream `id`, from its audit (when loaded) and the drafts: `answersDue`, for the pill. */
export function answersOwed(id: string, events: readonly WorkstreamEvent[] | undefined, proposals: readonly Proposal[]): boolean {
  return !!events && answersDue(events, proposals.filter((p) => workstreamOf(p) === id));
}

/** The detail an Idle workstream carries while the word check finds its ticket thin (a notice, never a need). */
export const UNCLEAR_DETAIL = "may be unclear";
/** What an idle row says once the reporter has answered on the ticket and the person has not chosen yet: the answer is the news. */
export const REPLIED_DETAIL = "reporter replied";

/** How long ago the reporter was asked, as the pill's detail: a bare "0d" does not say what it counts. */
const askedText = (days: number) => (days === 0 ? "asked today" : days === 1 ? "asked yesterday" : `asked ${days} days ago`);

/** How many days with nothing happening make a workstream Quiet when it has no cobweb to say so. */
export const QUIET_DAYS = 7;

const RUNNING = new Set<Run["state"]>(["launching", "working"]);
const at = (iso: string | null | undefined) => (iso ? Date.parse(iso) : NaN);

/** When something last happened in the workstream: its newest run event, else when it opened; NaN when unknown. */
function lastActivity(view: WorkstreamView, runs: readonly Run[]): number {
  const times = [at(view.workstream.createdAt), ...runs.flatMap((r) => [at(r.queuedAt), at(r.launchedAt), at(r.endedAt)])].filter((t) => !Number.isNaN(t));
  return times.length ? Math.max(...times) : NaN;
}

/** The reason after "Held": "after a restart", "the ticket was moved to Done", "automatic steps used up"; null when it says nothing more. */
function heldDetail(reason: string | null | undefined, view: WorkstreamView): string | null {
  const short = shortHeld(reason, view.workstream.drifted);
  if (!short || isHeldByYou(reason)) return null;
  if (short === "Held: budget") return "automatic steps used up";
  if (short === "Held: daily turns") return "today's Pip turns used up";
  return short.replace(/^Held:? ?/, "").replace(/^Paused: /, "") || null;
}

export function workstreamStatus(view: WorkstreamView, needs: readonly Pick<Need, "workstreamId">[], more: StatusMore = {}): WorkstreamStatus {
  const { runs = [], wither = null, now = new Date(), quietDays = QUIET_DAYS, learning = {}, answersOwed: owed = false } = more;
  const ws = view.workstream;
  const make = (state: StatusState, detail: string | null = null, word = STATUS_WORD[state]): WorkstreamStatus => ({ state, word, tone: STATUS_TONE[state], detail });
  const own = runs.filter((r) => view.runs.includes(r.id));
  const waiting = needsIn(needs, ws.id);
  const byYou = isHeldByYou(ws.heldReason);

  // A hold the system made is one of the needs; when it is the only one the one thing worth saying is why (the hold's own words), else the count.
  // What else the workstream waits on follows the count, so "1 waiting" does not hide that the reporter has been asked too.
  if (waiting > 0) return make("needs-you", [waiting === 1 && ws.heldReason && !byYou ? (shortHeld(ws.heldReason, ws.drifted) ?? `${waiting} waiting`) : `${waiting} waiting`, view.waitingOnReporter && ON_REPORTER_DETAIL, owed && OWED_DETAIL].filter(Boolean).join(" · "));
  // The person's own hold is quieter than one the system made: it asks nothing, so it is grey, not amber.
  if (ws.heldReason) return byYou ? { ...make("held", null, shortHeld(ws.heldReason) ?? "Held by you"), tone: "ink" } : make("held", heldDetail(ws.heldReason, view));
  if (view.waitingOnReporter) return make("waiting", askedText(waitedDays(view.waitingOnReporter.since, now)));
  const furthest = (pick: (r: Run) => boolean) => own.filter(pick).sort((a, b) => a.queuedAt.localeCompare(b.queuedAt)).pop();
  const going = furthest((r) => RUNNING.has(r.state)) ?? furthest((r) => r.state === "queued");
  if (going) return make("running", `${STAGE_LABEL[going.spec.kind]}${going.state === "queued" ? " queued" : ""}`);
  if (!ws.closedAt && view.stage !== "done") {
    if (wither && wither.level > 0) return make("quiet", witherShort(wither));
    const last = lastActivity(view, own);
    if (!Number.isNaN(last) && (now.getTime() - last) / 86_400_000 >= quietDays) return make("quiet", `no activity · ${Math.floor((now.getTime() - last) / 86_400_000)}d`);
  }
  if (ws.closedAt || view.stage === "done") return make("done");
  const failed = [...own].sort((a, b) => a.queuedAt.localeCompare(b.queuedAt)).pop();
  const unclear = !!view.clarity && flaggedGaps(view.clarity.gaps, learning, projectOfKey(ws.itemKey ?? "")).length > 0;
  return make("idle", failed?.state === "failed" ? `${STAGE_LABEL[failed.spec.kind]} failed` : owed ? OWED_DETAIL : view.reporterReplied ? REPLIED_DETAIL : unclear ? UNCLEAR_DETAIL : null);
}

/** Whether a status matches a filter word the palette takes: "waiting on reporter", "needs you", "held", "running", "quiet", "done", "idle". */
export function statusFromWords(words: string): StatusState | null {
  const w = words.trim().toLowerCase().replace(/\s+/g, " ");
  if (!w) return null;
  if (w === "held by you") return "held";
  return STATUS_ORDER.find((s) => STATUS_WORD[s].toLowerCase() === w || (s === "waiting" && (w === "waiting" || w === WAITING_STATUS.toLowerCase()))) ?? null;
}
