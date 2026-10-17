import { repeatedComments, safeToBatch } from "../lib/needs";
import { inWorkstreamPane } from "../lib/proposals";
import { shortHeld } from "../lib/workstreamHold";
import { byQueue, REVIEW_POSTED, reviewPosted, STAGE_LABEL } from "../lib/workstreamStage";
import type { CodeChange, Proposal, ReviewView, Run, RunKind, WorkstreamEvent, WorkstreamView } from "../types";
import { liveCounts, liveWords, needsPerson, stateView, stoppedAtLimit, type Tone } from "./agentsLogic";
import { keptEditsOfDraft } from "./DraftCard";
import { liveDraft } from "./draftLive";
import { shownVerdict, verdictChip } from "./runSheetLogic";
import type { WorkstreamSuggestionScene } from "./suggestions";

/** Pure helpers behind Pip home's workstream rows and its step rail. They read the live stores' values and decide nothing. */

export { shortHeld };

const RUNNING = new Set<Run["state"]>(["launching", "working"]);

/** When a workstream was last held, from its audit (`events`, oldest first); null when the audit never says. */
export function lastHeldAt(events: readonly Pick<WorkstreamEvent, "action" | "at">[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) if (events[i].action === "held") return events[i].at;
  return null;
}

/** The steps of a workstream's chain, in order, as Pip home's step rail shows them. */
export const STEP_KINDS: readonly RunKind[] = ["investigate", "triage", "plan", "build", "review", "verify"];

/** How many fix rounds the rules send a build before the review is the person's again, as `fix_round` allows. */
export const FIX_ROUNDS = 2;

/** Where a draft goes on the step rail: under the step it is about, or with Pip's own drafts at the top. */
export type StepGroup = RunKind | "pip";

const isOpen = (p: Proposal) => p.state.type === "pending" || p.state.type === "applying";

/**
 * The step a workstream's draft is about: a run draft's own kind; a draft a run left, or a follow-up or answer to a run,
 * that run's kind; anything else (a comment Pip drafted in the conversation, say) is one of Pip's drafts.
 */
export function draftStep(p: Proposal, runs: readonly Pick<Run, "id" | "spec">[]): StepGroup {
  if (p.intent.type === "startRun") return p.intent.spec.kind;
  const runId = p.origin.type === "run" ? p.origin.runId : p.intent.type === "followUp" || p.intent.type === "runAnswer" ? p.intent.runId : null;
  return runs.find((r) => r.id === runId)?.spec.kind ?? "pip";
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
export const BATCH_TITLE = "Safe drafts are comments, status moves and subtasks that only add to Jira. A description rewrite, a question to the reporter and the like are approved one by one. You see every draft before anything is posted.";

/** What a group says under its needs when drafts from the person's own reply are left out of "Approve N safe drafts". */
export const BATCH_ASIDE = "Not in the batch: drafts from your reply are read on their own.";

/** What a group says under its needs when drafts the person edited are left out of "Approve N safe drafts". */
export const EDITED_ASIDE = "Not in the batch: drafts you edited are posted from their card.";

/** Whether draft `id` holds an edit its stored text doesn't, on a mounted card or kept for one: only the card posts those words, so no batch does. */
export const draftEdited = (id: string): boolean => !!liveDraft(id)?.edited || !!keptEditsOfDraft(id);

/** The pending drafts among `drafts` that the person edited and no batch covers. */
export const editedPending = (drafts: readonly Proposal[]): Proposal[] => drafts.filter((p) => p.state.type === "pending" && draftEdited(p.id));

/**
 * The drafts of a step that "Approve N safe drafts" would approve, in order; it is offered only for two or more. A comment
 * with the same text as an earlier one on its ticket is left to be decided on its own (see `repeatedComments`), and one the
 * person edited is posted from its card, since approving here would post the stored text.
 */
export function batchable(drafts: readonly Proposal[]): Proposal[] {
  // Edited drafts go first, so an edited copy of a comment can't make its unedited twin count as the repeat.
  const unedited = drafts.filter((p) => !draftEdited(p.id));
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
  kind: RunKind;
  label: string;
  /** The step's runs in the workstream, oldest first. */
  runs: Run[];
  newest: Run | null;
  /** How the newest run stands ("Working", "Ready to review"), or "waiting for PR" for a build whose pull request isn't found yet. */
  state: string | null;
  tone: Tone | null;
  /** The newest run was started by an automatic step. */
  auto: boolean;
  /** A review's verdict once it is read: "Pass", "Blocking · 2". */
  verdict: string | null;
  /** "fix round 1/2" once the rules sent the build back; "fix round 3 (yours, after 2 automatic)" once the person did. */
  fixRound: string | null;
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

/** The build's fix rounds as its chip says them: the automatic ones out of `FIX_ROUNDS`, and the person's after them. */
export function fixRoundChip(automatic: number, yours: number): string | null {
  if (!yours) return automatic ? `fix round ${Math.min(automatic, FIX_ROUNDS)}/${FIX_ROUNDS}` : null;
  return `fix round ${automatic + yours} (${yours === 1 ? "yours" : `${yours} yours`}, after ${automatic} automatic)`;
}

/**
 * The six step chips of a workstream from its runs (`runs`, only the workstream's own), its audit (`events`, for the
 * fix rounds sent), the reviews' verdicts as read so far and its drafts (`proposals`, for what waits in each step).
 */
export function stepChips(runs: readonly Run[], events: readonly (Pick<WorkstreamEvent, "action" | "runId" | "actor"> & Partial<Pick<WorkstreamEvent, "at">>)[], verdicts: Readonly<Record<string, ReviewView | null>>, proposals: readonly Proposal[], { now = Date.now(), waitingForPr = null, changes = {} }: StepChipOptions = {}): StepChip[] {
  const drafts = stepDrafts(proposals, runs);
  return STEP_KINDS.map((kind) => {
    const own = runs.filter((r) => r.spec.kind === kind).sort(byQueue);
    const newest = own[own.length - 1] ?? null;
    const view = newest ? stateView(newest, now) : null;
    const waiting = kind === "build" && !!waitingForPr && newest?.state === "done";
    const review = kind === "review" && newest ? shownVerdict(newest, verdicts) : null;
    const ids = new Set(own.map((r) => r.id));
    const sent = kind === "build" ? events.filter((e) => e.action === "fix_round_sent" && e.runId !== null && ids.has(e.runId)) : [];
    const yours = sent.filter((e) => e.actor === "person").length;
    const pendingDrafts = (drafts[kind] ?? []).filter((p) => p.state.type === "pending");
    // A run asking a question that has a reply drafted waits on the person once, as the tray counts it.
    const answered = new Set(pendingDrafts.flatMap((p) => (p.intent.type === "runAnswer" ? [p.intent.runId] : [])));
    const pending = pendingDrafts.length;
    return {
      kind,
      label: STAGE_LABEL[kind],
      runs: own,
      newest,
      state: waiting ? "waiting for PR" : (view?.label ?? null),
      tone: waiting ? "warn" : (view?.tone ?? null),
      auto: !!newest?.autoStart,
      verdict: review ? (review.verdict !== "pass" && newest && reviewPosted(events, newest) ? REVIEW_POSTED : verdictChip(review)) : null,
      fixRound: fixRoundChip(sent.length - yours, yours),
      needsYou: pending + own.filter((r) => (needsPerson(r) || stoppedAtLimit(r)) && !(r.state === "needsAnswer" && answered.has(r.id))).length,
      pr: kind === "build" ? buildPullRequest(own, changes) : null,
    };
  });
}

/**
 * The step the rail points the person at next, from its chips (in `STEP_KINDS` order): the furthest step that has a run,
 * while its newest run hasn't finished well; once it has, the step after it. The first step when nothing has run, and
 * null once Verify is done.
 */
export function nextStep(chips: readonly Pick<StepChip, "kind" | "newest">[]): RunKind | null {
  let furthest = -1;
  chips.forEach((c, i) => {
    if (c.newest) furthest = i;
  });
  if (furthest < 0) return chips[0]?.kind ?? null;
  if (chips[furthest].newest?.state !== "done") return chips[furthest].kind;
  return chips[furthest + 1]?.kind ?? null;
}

/**
 * Pip home's composer footer: "2 agents running · 1 quiet · 1 queued · 2 need you", counting every run in a workstream or not
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

/** The plan's description update of workstream `view` that waits for the person, the newest if there are several; null when none does. */
export function planRewriteDraft(view: WorkstreamView, runs: readonly Run[], proposals: readonly Proposal[]): Proposal | null {
  const own = runs.filter((r) => view.runs.includes(r.id) || r.spec.workstream === view.workstream.id);
  const plans = proposals.filter((p) => p.state.type === "pending" && p.intent.type === "rewrite" && inWorkstreamPane(p, view.workstream) && draftStep(p, own) === "plan");
  return plans.sort((a, b) => a.createdAt.localeCompare(b.createdAt)).pop() ?? null;
}

/** The parts of a turn the suggestion scene reads: whether Pip was woken, and in what order. */
type SceneTurn = { kind?: "user" | "wake" };

/**
 * What the suggestion chips need to know about workstream `view`: where it stands, whether it is held, whether a plan's
 * description update or a run start waits, whether it was investigated, whether Pip was woken since the person last
 * wrote (`turns`, its conversation's, oldest first), and the run at work, by its label.
 */
export function workstreamSuggestionScene(view: WorkstreamView, runs: readonly Run[], proposals: readonly Proposal[], turns: readonly SceneTurn[], cobweb = false): WorkstreamSuggestionScene {
  const own = runs.filter((r) => view.runs.includes(r.id) || r.spec.workstream === view.workstream.id);
  const pending = proposals.filter((p) => p.state.type === "pending" && inWorkstreamPane(p, view.workstream));
  const labels = new Map(view.labels);
  const going = own.filter((r) => RUNNING.has(r.state)).sort(byQueue).pop();
  const lastAsked = turns.map((t) => t.kind ?? "user").lastIndexOf("user");
  return {
    key: view.workstream.itemKey,
    stage: view.stage,
    mode: view.workstream.mode,
    heldReason: view.workstream.heldReason,
    hasPendingPlanRewrite: planRewriteDraft(view, runs, proposals) !== null,
    hasPendingStartDraft: pending.some((p) => p.intent.type === "startRun"),
    investigated: own.some((r) => r.spec.kind === "investigate" && r.state === "done"),
    woke: turns.slice(lastAsked + 1).some((t) => t.kind === "wake"),
    running: going ? (labels.get(going.id) ?? null) : null,
    unclear: !!view.readiness,
    cobweb,
  };
}

/**
 * Where Pip home lands on its first load with nothing selected: the workstream of the top need in Needs you (`{ id }`;
 * General's own, `{ id: null }`, when the top need is not in a workstream). Null while there is nothing to land on yet: no
 * need, or its workstream is not among the `openIds` read so far.
 */
export function landingSelection(needsYou: readonly { workstreamId: string | null }[], openIds: readonly string[]): { id: string | null } | null {
  const top = needsYou[0];
  if (!top) return null;
  if (top.workstreamId === null) return { id: null };
  return openIds.includes(top.workstreamId) ? { id: top.workstreamId } : null;
}
