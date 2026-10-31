import { repeatedComments, safeToBatch } from "../lib/needs";
import { isRunDraft } from "../lib/proposals";
import { stageOf, type Step } from "../lib/roles";
import { byQueue, REVIEW_POSTED, reviewPosted, STAGE_LABEL } from "../lib/workstreamStage";
import type { CodeChange, ConnectionInfo, Proposal, ReviewView, Run, WorkstreamEvent } from "../types";
import { liveCounts, liveWords, needsPerson, runApproved, stateView, type Tone } from "./agentsLogic";
import { keptEditsOfDraft } from "./DraftCard";
import { heldNote } from "../lib/proposals";
import { liveDraft } from "./draftLive";
import { useWorkspace } from "../workspaceStore";
import { shownVerdict, verdictChip } from "./runSheetLogic";

/** Pure helpers behind a workstream's step rail and the drawer's footer. They read the live stores' values and decide nothing. */

/** When a workstream was last paused, from its audit (`events`, oldest first; an earlier version's hold counts); null when the audit never says. */
export function lastPausedAt(events: readonly Pick<WorkstreamEvent, "action" | "at">[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) if (events[i].action === "paused" || events[i].action === "held") return events[i].at;
  return null;
}

/** The steps of a workstream's chain, in order, as a workstream's step rail shows them. */
export const STEP_KINDS: readonly Step[] = ["investigate", "triage", "plan", "build", "review", "verify"];

/** Where a draft goes on the step rail: under the step it is about, or with Pip's own drafts at the top. */
export type StepGroup = Step | "pip";

const isOpen = (p: Proposal) => p.state.type === "pending" || p.state.type === "applying";

/**
 * The step a workstream's draft is about: a run draft's own role; a draft a run left, or a follow-up or answer to a run,
 * that run's; anything else (a comment Pip drafted in the conversation, say) is one of Pip's drafts.
 */
export function draftStep(p: Proposal, runs: readonly Pick<Run, "id" | "spec">[]): StepGroup {
  if (p.intent.type === "startRun") return stageOf(p.intent.spec.role);
  const runId = p.origin.type === "run" ? p.origin.runId : p.intent.type === "followUp" || p.intent.type === "runAnswer" ? p.intent.runId : null;
  const run = runs.find((r) => r.id === runId);
  return run ? stageOf(run.spec.role) : "pip";
}

/** The workstream's open drafts by the step they are about, oldest first; a step with none is absent. */
export function stepDrafts(proposals: readonly Proposal[], runs: readonly Pick<Run, "id" | "spec">[]): Partial<Record<StepGroup, Proposal[]>> {
  const groups: Partial<Record<StepGroup, Proposal[]>> = {};
  for (const p of [...proposals].filter(isOpen).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || (a.id < b.id ? -1 : 1))) {
    const step = draftStep(p, runs);
    (groups[step] ??= []).push(p);
  }
  return groups;
}

/** The workstream's retired drafts (replaced by a newer one, or out of date) by the step they were about, oldest first; a step with none is absent. */
export function retiredStepDrafts(proposals: readonly Proposal[], runs: readonly Pick<Run, "id" | "spec">[]): Partial<Record<StepGroup, Proposal[]>> {
  const groups: Partial<Record<StepGroup, Proposal[]>> = {};
  for (const p of [...proposals].filter((p) => p.state.type === "retired").sort((a, b) => a.createdAt.localeCompare(b.createdAt) || (a.id < b.id ? -1 : 1))) {
    (groups[draftStep(p, runs)] ??= []).push(p);
  }
  return groups;
}

/** What the one action of approving N drafts together is called, in the step rail and in Needs you. */
export const batchLabel = (count: number) => `Approve ${count} safe drafts`;

/** What the step rail's batch button is called: the same action as Needs you's, named by the smaller scope it covers. */
export const stepBatchLabel = (step: StepGroup, count: number) => (step === "pip" ? `Approve ${count} of Pip's drafts` : `Approve ${count} of this step's drafts`);

/** What the batch button's tooltip says makes a draft safe: it is a comment, a move or subtasks, read in full before anything is posted. */
export const BATCH_TITLE = "Safe drafts are comments, status moves and subtasks that only add to Jira. A description rewrite and the like are approved one by one. You see every draft before anything is posted.";

/** What a group says under its needs when drafts the person edited are left out of "Approve N safe drafts". */
export const EDITED_ASIDE = "Not in the batch: drafts you edited are posted from their card.";

/** Whether draft `id` holds an edit its stored text doesn't, on a mounted card or kept for one: only the card posts those words, so no batch does. */
export const draftEdited = (id: string): boolean => !!liveDraft(id)?.edited || !!keptEditsOfDraft(id);

/** The pending drafts among `drafts` that the person edited and no batch covers. */
export const editedPending = (drafts: readonly Proposal[]): Proposal[] => drafts.filter((p) => p.state.type === "pending" && draftEdited(p.id));

/**
 * The drafts of a step that "Approve N safe drafts" would approve, in order; it is offered only for two or more. A comment
 * with the same text as an earlier one on its ticket is left to be decided on its own (see `repeatedComments`), and one the
 * person edited is posted from its card, since approving here would post the stored text. A draft whose connection is off
 * waits.
 */
export function batchable(drafts: readonly Proposal[], connections: readonly ConnectionInfo[] = useWorkspace.getState().connections): Proposal[] {
  // Edited drafts go first, so an edited copy of a comment can't make its unedited twin count as the repeat.
  const unedited = drafts.filter((p) => !draftEdited(p.id) && !heldNote(p, connections));
  const repeated = new Set(repeatedComments(unedited).map((p) => p.id));
  return unedited.filter((p) => p.state.type === "pending" && safeToBatch(p) && !repeated.has(p.id));
}

/** What an "Approve N safe drafts" covers, fixed when its confirm opens: each draft by id, with the revision shown then. */
export type BatchSnapshot = readonly { id: string; revision: number }[];

/** The snapshot of `drafts` a confirm opening now covers: only the ones `batchable` lets go together. */
export function freezeBatch(drafts: readonly Proposal[]): BatchSnapshot {
  return batchable(drafts).map((p) => ({ id: p.id, revision: p.revisions.length }));
}

/**
 * What a confirmed "Approve N safe drafts" approves, from the step's drafts now: exactly the ones its confirm covered, each
 * still pending, batchable and as it was then. A draft that came in since isn't among them; null when one of them was
 * decided or revised meanwhile, so the person never approves what they didn't see.
 */
export function batchToApprove(frozen: BatchSnapshot, drafts: readonly Proposal[]): Proposal[] | null {
  const now = new Map(batchable(drafts).map((p) => [p.id, p]));
  const picked: Proposal[] = [];
  for (const { id, revision } of frozen) {
    const p = now.get(id);
    if (!p || p.revisions.length !== revision) return null;
    picked.push(p);
  }
  return picked;
}

/** One step on the rail: its runs and how the newest stands, and what waits on the person in it. */
export interface StepChip {
  kind: Step;
  label: string;
  /** The step's runs in the workstream, oldest first. */
  runs: Run[];
  newest: Run | null;
  /** How the newest run stands ("Working", "Ready to review"), or "waiting for PR" for a build whose pull request isn't found yet. */
  state: string | null;
  tone: Tone | null;
  /** A review's verdict once it is read: "Pass", "Blocking · 2". */
  verdict: string | null;
  /** Pending drafts under the step, and runs in it asking the person something. */
  needsYou: number;
  /** For Build: the pull request its newest build to have one opened, once a sync has found it. */
  pr: Pick<CodeChange, "number" | "title" | "url" | "state"> | null;
}

export interface StepChipOptions {
  now?: number;
  /** The workstream's `waitingForPr`: its finished build's pull request isn't found yet. */
  waitingForPr?: string | null;
  /** What each finished build produced, by run id, as far as a sync has seen it. */
  changes?: Readonly<Record<string, CodeChange | null>>;
}

/** The pull request of the newest of `builds` (oldest first) that has one. */
function buildPullRequest(builds: readonly Run[], changes: Readonly<Record<string, CodeChange | null>>): StepChip["pr"] {
  for (let i = builds.length - 1; i >= 0; i--) {
    const change = changes[builds[i].id];
    if (change?.kind === "pullRequest" && change.number != null) return { number: change.number, title: change.title, url: change.url, state: change.state };
  }
  return null;
}

/**
 * The six step chips of a workstream from its runs (`runs`, only the workstream's own), its audit (`events`, for a posted
 * review), the reviews' verdicts as read so far and its drafts (`proposals`, for what waits in each step).
 */
export function stepChips(runs: readonly Run[], events: readonly (Pick<WorkstreamEvent, "action" | "runId" | "actor"> & Partial<Pick<WorkstreamEvent, "at">>)[], verdicts: Readonly<Record<string, ReviewView | null>>, proposals: readonly Proposal[], { now = Date.now(), waitingForPr = null, changes = {} }: StepChipOptions = {}): StepChip[] {
  const drafts = stepDrafts(proposals, runs);
  return STEP_KINDS.map((kind) => {
    const own = runs.filter((r) => stageOf(r.spec.role) === kind).sort(byQueue);
    const newest = own[own.length - 1] ?? null;
    const view = newest ? stateView(newest, now, runApproved(newest, proposals)) : null;
    const waiting = kind === "build" && !!waitingForPr && newest?.state === "done";
    const review = kind === "review" && newest ? shownVerdict(newest, verdicts) : null;
    const pendingDrafts = (drafts[kind] ?? []).filter((p) => p.state.type === "pending" && !isRunDraft(p.intent));
    const pending = pendingDrafts.length;
    return {
      kind,
      label: STAGE_LABEL[kind],
      runs: own,
      newest,
      state: waiting ? "waiting for PR" : (view?.label ?? null),
      tone: waiting ? "warn" : (view?.tone ?? null),
      verdict: review ? (review.verdict !== "pass" && newest && reviewPosted(events, newest) ? REVIEW_POSTED : verdictChip(review)) : null,
      needsYou: pending + own.filter((r) => needsPerson(r)).length,
      pr: kind === "build" ? buildPullRequest(own, changes) : null,
    };
  });
}

/**
 * The step the rail points the person at next, from its chips (in `STEP_KINDS` order): the furthest step that has a run,
 * while its newest run hasn't finished well; once it has, the step after it. The first step when nothing has run, and
 * null once Verify is done.
 */
export function nextStep(chips: readonly Pick<StepChip, "kind" | "newest">[]): Step | null {
  let furthest = -1;
  chips.forEach((c, i) => {
    if (c.newest) furthest = i;
  });
  if (furthest < 0) return chips[0]?.kind ?? null;
  if (chips[furthest].newest?.state !== "done") return chips[furthest].kind;
  return chips[furthest + 1]?.kind ?? null;
}

/**
 * The composer footer: "2 agents running · 1 quiet · 1 queued · 2 need you", counting every run in a workstream or not
 * as the Agents view's summary does (`liveCounts`), so the two never disagree on how many are running, then how many things
 * need the person (`needsYou`, the one count). It is told under the input, never in the conversation.
 */
export function composerFooter(runs: readonly Run[], needsYou: number, now: number = Date.now()): string {
  const live = liveCounts(runs, now);
  const rest = liveWords({ ...live, running: 0 });
  const agents = [live.running ? `${live.running} ${live.running === 1 ? "agent" : "agents"} running` : "Nothing running", ...(live.quiet ? [`${live.quiet} quiet`] : []), ...rest];
  const n = needsYou;
  return [...agents, n === 0 ? "nothing needs you" : `${n} ${n === 1 ? "needs" : "need"} you`].join(" · ");
}
