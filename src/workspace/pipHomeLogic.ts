import { inWorkstreamPane, targetOf, workstreamOf } from "../lib/proposals";
import { heldText } from "../lib/workstreamHold";
import { byQueue, STAGE_LABEL } from "../lib/workstreamStage";
import { HELD_BUDGET, HELD_DAILY, TRIPWIRE } from "../types";
import type { BasisField, CodeChange, Intent, Proposal, ReviewView, Run, RunKind, WorkstreamEvent, WorkstreamView } from "../types";
import { needsPerson, stateView, type Tone } from "./agentsLogic";
import { shownVerdict, verdictChip } from "./runSheetLogic";
import type { WorkstreamSuggestionScene } from "./suggestions";
import { runWorkstream } from "./workstreamsStore";

/** Pure helpers behind Pip home's workstream rows and its Needs you tray. They read the live stores' values and decide nothing. */

/** What a workstream's held banner says, shortened for a row or the tray: "Held: budget", "Held by you", "Held: tripwire, …". */
export function shortHeld(reason: string | null | undefined, drifted?: readonly BasisField[] | null): string | null {
  const text = heldText(reason, drifted);
  if (!text || !reason) return null;
  if (reason === HELD_BUDGET) return "Held: budget";
  if (reason === HELD_DAILY) return "Held: daily turns";
  if (reason.startsWith(TRIPWIRE)) return `Held: tripwire, ${text.replace(/^Held: /, "")}`;
  return text;
}

/** Kinds in the order a workstream goes through them, for the furthest run. */
const RANK: Record<Run["spec"]["kind"], number> = { investigate: 0, triage: 1, plan: 2, build: 3, review: 4, verify: 5 };

const RUNNING = new Set<Run["state"]>(["launching", "working"]);

/**
 * A row's short status, the first that applies: why it is held; waiting for the build's pull request; the furthest
 * run going ("Plan running") or waiting its turn ("Build queued"); "Needs you" while a run asks something or anything
 * else waits on the person in it (`waiting`, its drafts among them); the last run queued failed ("Review failed");
 * else "Done" or "Idle".
 */
export function workstreamStatus(view: WorkstreamView, runs: readonly Run[], waiting = 0): string {
  const held = shortHeld(view.workstream.heldReason, view.workstream.drifted);
  if (held) return held;
  if (view.waitingForPr) return "waiting for PR";
  const own = runs.filter((r) => view.runs.includes(r.id));
  const furthest = (pick: (r: Run) => boolean) => own.filter(pick).sort((a, b) => RANK[a.spec.kind] - RANK[b.spec.kind] || byQueue(a, b)).pop();
  const going = furthest((r) => RUNNING.has(r.state));
  if (going) return `${STAGE_LABEL[going.spec.kind]} running`;
  const queued = furthest((r) => r.state === "queued");
  if (queued) return `${STAGE_LABEL[queued.spec.kind]} queued`;
  if (waiting > 0 || own.some(needsPerson)) return "Needs you";
  const last = [...own].sort(byQueue).pop();
  if (last?.state === "failed") return `${STAGE_LABEL[last.spec.kind]} failed`;
  return view.stage === "done" ? "Done" : "Idle";
}

/** What kind of wait an item in the tray is. */
export type NeedsYouKind = "draft" | "runStart" | "question" | "permission" | "failure" | "held";

/** What activating an item brings into view: a draft card, a run card (and its sheet), or the workstream's held banner. */
export type NeedsYouTarget = { type: "draft"; id: string } | { type: "run"; id: string } | { type: "workstream" };

/** One thing waiting on the person. `workstreamId` null is General. */
export interface NeedsYouItem {
  /** Unique across the list: the kind of thing and its id. */
  key: string;
  kind: NeedsYouKind;
  workstreamId: string | null;
  label: string;
  /** When it started waiting, as an ISO time. */
  at: string;
  target: NeedsYouTarget;
}

export interface NeedsYouInput {
  /** The open workstreams; a closed one's waits go to General. */
  workstreams: readonly WorkstreamView[];
  runs: readonly Run[];
  proposals: readonly Proposal[];
  /** Failed runs the person has already looked at. */
  seenFailed: ReadonlySet<string>;
  /** When each held workstream was last held, by id, where that is known; otherwise its `createdAt` stands in. */
  heldAt?: Readonly<Record<string, string>>;
}

const DRAFT_TEXT: Record<Exclude<Intent["type"], "startRun">, string> = {
  comment: "Draft comment",
  transition: "Draft move",
  subtasks: "Draft subtasks",
  create: "Draft ticket",
  link: "Draft link",
  update: "Draft change",
  rewrite: "Draft rewrite",
  followUp: "Draft follow-up",
  runAnswer: "Draft answer",
  githubReview: "Draft review",
};

/** The open workstream a draft belongs to: the one it was made in, else the first whose conversation shows it; null is General. */
function draftWorkstream(p: Proposal, open: readonly WorkstreamView[]): string | null {
  const made = workstreamOf(p);
  if (made && open.some((v) => v.workstream.id === made)) return made;
  return open.find((v) => inWorkstreamPane(p, v.workstream))?.workstream.id ?? null;
}

/** "R2" in its workstream, else the run's kind. */
function runName(run: Run, ws: WorkstreamView | null): string {
  return ws?.labels.find(([id]) => id === run.id)?.[1] ?? `${STAGE_LABEL[run.spec.kind]} agent`;
}

const prefix = (key: string | null | undefined, text: string) => (key ? `${key} · ${text}` : text);

/** The pending answer drafts for runs still asking, by run id, the oldest when there are several: each run's question carries its one. */
function answersByRun(proposals: readonly Proposal[], runs: readonly Run[]): Map<string, Proposal> {
  const asking = new Set(runs.filter((r) => r.state === "needsAnswer").map((r) => r.id));
  const out = new Map<string, Proposal>();
  for (const p of [...proposals].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    if (p.state.type === "pending" && p.intent.type === "runAnswer" && asking.has(p.intent.runId) && !out.has(p.intent.runId)) out.set(p.intent.runId, p);
  }
  return out;
}

/**
 * Everything waiting on the person across the open workstreams and General, oldest first by when it started waiting:
 * pending drafts (a draft run start apart), runs asking a question, asking permission or blocked (a folder to trust
 * among them), failed runs not yet looked at, and held workstreams. A run asking a question that Pip suggested a reply
 * to is one item, which goes to the reply. Decided drafts, runs that moved on and lifted holds aren't there, so an item
 * goes as soon as the stores say its wait is over.
 */
export function needsYouItems({ workstreams, runs, proposals, seenFailed, heldAt }: NeedsYouInput): NeedsYouItem[] {
  const open = workstreams.filter((v) => v.workstream.closedAt === null);
  const items: NeedsYouItem[] = [];
  const answers = answersByRun(proposals, runs);
  const carried = new Set([...answers.values()].map((p) => p.id));
  for (const p of proposals) {
    if (p.state.type !== "pending" || carried.has(p.id)) continue;
    const workstreamId = draftWorkstream(p, open);
    const target = { type: "draft", id: p.id } as const;
    if (p.intent.type === "startRun") {
      items.push({ key: `draft:${p.id}`, kind: "runStart", workstreamId, label: prefix(targetOf(p.intent)?.key, `Start ${STAGE_LABEL[p.intent.spec.kind]}`), at: p.createdAt, target });
    } else {
      // A draft a run left says which run, so a review's comments in the tray can be told apart: "CA-401 · R5 comment".
      const from = p.origin.type === "run" ? p.origin.runId : null;
      const ws = workstreamId ? open.find((v) => v.workstream.id === workstreamId) : undefined;
      const label = from && ws?.labels.find(([id]) => id === from)?.[1];
      const text = label ? `${label} ${DRAFT_TEXT[p.intent.type].replace(/^Draft /, "")}` : DRAFT_TEXT[p.intent.type];
      items.push({ key: `draft:${p.id}`, kind: "draft", workstreamId, label: prefix(targetOf(p.intent)?.key, text), at: p.createdAt, target });
    }
  }
  for (const run of runs) {
    const ws = runWorkstream(open, run);
    const name = runName(run, ws);
    const at = run.lastProgressAt ?? run.endedAt ?? run.queuedAt;
    const base = { key: `run:${run.id}`, workstreamId: ws?.workstream.id ?? null, at, target: { type: "run", id: run.id } as const };
    const key = run.item?.key;
    const answer = answers.get(run.id);
    if (answer) items.push({ ...base, key: `draft:${answer.id}`, kind: "question", label: prefix(key, `${name} asks a question · ${answer.createdBy === "pip" ? "Pip suggests a reply" : "a reply is drafted"}`), target: { type: "draft", id: answer.id } });
    else if (run.state === "needsAnswer") items.push({ ...base, kind: "question", label: prefix(key, `${name} asks a question`) });
    else if (run.state === "needsPermission" || run.state === "systemBlocked") items.push({ ...base, kind: "permission", label: prefix(key, `${name} needs permission`) });
    else if (run.state === "failed" && !seenFailed.has(run.id)) {
      const trust = run.failure?.type === "untrustedFolder";
      items.push({ ...base, kind: trust ? "permission" : "failure", label: prefix(key, trust ? `${name} needs its folder trusted` : `${name} failed`) });
    }
  }
  for (const v of open) {
    const held = shortHeld(v.workstream.heldReason, v.workstream.drifted);
    if (!held) continue;
    const id = v.workstream.id;
    items.push({ key: `held:${id}`, kind: "held", workstreamId: id, label: prefix(v.workstream.itemKey, held), at: heldAt?.[id] ?? v.workstream.createdAt, target: { type: "workstream" } });
  }
  return items.sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** How many of `items` wait in workstream `workstreamId`; null counts General's. */
export function needsYouCount(items: readonly NeedsYouItem[], workstreamId: string | null): number {
  return items.filter((i) => i.workstreamId === workstreamId).length;
}

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

/** Drafts a step's "Approve these" may approve together: pending comments, moves and subtasks. A description rewrite is read in its diff first, and a run or follow-up after its prompt or message, so never. */
const BATCHABLE: ReadonlySet<Intent["type"]> = new Set(["comment", "transition", "subtasks"]);

/** The drafts of a step that "Approve these N" would approve, in order; it is offered only for two or more. */
export function batchable(drafts: readonly Proposal[]): Proposal[] {
  return drafts.filter((p) => p.state.type === "pending" && BATCHABLE.has(p.intent.type));
}

/** What a step's "Approve these N" covers, fixed when its confirm opens: each draft by id, with the revision shown then. */
export type BatchSnapshot = readonly { id: string; revision: number }[];

/** The snapshot of `drafts` a confirm opening now covers: only the ones `batchable` lets go together. */
export function freezeBatch(drafts: readonly Proposal[]): BatchSnapshot {
  return batchable(drafts).map((p) => ({ id: p.id, revision: p.revisions.length }));
}

/**
 * What a confirmed "Approve these N" approves, from the step's drafts now: exactly the ones its confirm covered, each
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
  /** "fix round 1/2" once the rules sent the build back. */
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

/**
 * The six step chips of a workstream from its runs (`runs`, only the workstream's own), its audit (`events`, for the
 * fix rounds sent), the reviews' verdicts as read so far and its drafts (`proposals`, for what waits in each step).
 */
export function stepChips(runs: readonly Run[], events: readonly Pick<WorkstreamEvent, "action" | "runId">[], verdicts: Readonly<Record<string, ReviewView | null>>, proposals: readonly Proposal[], { now = Date.now(), waitingForPr = null, changes = {} }: StepChipOptions = {}): StepChip[] {
  const drafts = stepDrafts(proposals, runs);
  return STEP_KINDS.map((kind) => {
    const own = runs.filter((r) => r.spec.kind === kind).sort(byQueue);
    const newest = own[own.length - 1] ?? null;
    const view = newest ? stateView(newest, now) : null;
    const waiting = kind === "build" && !!waitingForPr && newest?.state === "done";
    const review = kind === "review" && newest ? shownVerdict(newest, verdicts) : null;
    const ids = new Set(own.map((r) => r.id));
    const rounds = kind === "build" ? events.filter((e) => e.action === "fix_round_sent" && e.runId !== null && ids.has(e.runId)).length : 0;
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
      verdict: review ? verdictChip(review) : null,
      fixRound: rounds ? `fix round ${Math.min(rounds, FIX_ROUNDS)}/${FIX_ROUNDS}` : null,
      needsYou: pending + own.filter((r) => needsPerson(r) && !(r.state === "needsAnswer" && answered.has(r.id))).length,
      pr: kind === "build" ? buildPullRequest(own, changes) : null,
    };
  });
}

/**
 * Pip home's composer footer: "2 agents working · 1 queued · 2 need you", counting every run starting or at work and
 * every run waiting its turn, in a workstream or not, as everything waiting on the person (`needsYou`) is counted. It
 * is told under the input, never in the conversation.
 */
export function composerFooter(runs: readonly Run[], needsYou: readonly NeedsYouItem[]): string {
  const working = runs.filter((r) => RUNNING.has(r.state)).length;
  const queued = runs.filter((r) => r.state === "queued").length;
  const agents = working === 0 ? "No agents working" : `${working} ${working === 1 ? "agent" : "agents"} working`;
  const n = needsYou.length;
  return [agents, ...(queued ? [`${queued} queued`] : []), n === 0 ? "nothing needs you" : `${n} ${n === 1 ? "needs" : "need"} you`].join(" · ");
}

/** The parts of a turn the suggestion scene reads: whether Pip was woken, and in what order. */
type SceneTurn = { kind?: "user" | "wake" };

/**
 * What the suggestion chips need to know about workstream `view`: where it stands, whether it is held, whether a plan's
 * description update or a run start waits, whether it was investigated, whether Pip was woken since the person last
 * wrote (`turns`, its conversation's, oldest first), and the run at work, by its label.
 */
export function workstreamSuggestionScene(view: WorkstreamView, runs: readonly Run[], proposals: readonly Proposal[], turns: readonly SceneTurn[]): WorkstreamSuggestionScene {
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
    hasPendingPlanRewrite: pending.some((p) => p.intent.type === "rewrite" && draftStep(p, own) === "plan"),
    hasPendingStartDraft: pending.some((p) => p.intent.type === "startRun"),
    investigated: own.some((r) => r.spec.kind === "investigate" && r.state === "done"),
    woke: turns.slice(lastAsked + 1).some((t) => t.kind === "wake"),
    running: going ? (labels.get(going.id) ?? null) : null,
  };
}
