import { docText } from "../lib/docs";
import { reporterFollow } from "../lib/reporterWait";
import { clarityGaps, type ClarityGap } from "../lib/ticketClarity";
import { workstreamOf } from "../lib/proposals";
import { budgetLevel, budgetView } from "../lib/workstreamHold";
import { byQueue, reviewBlocking, runLabels, stage } from "../lib/workstreamStage";
import { readStored, writeStored } from "../workspace/storage";
import { ALLOW_MORE_STEPS, BASIS_FIELDS, HELD_ALL, HELD_BUDGET, HELD_DAILY, HELD_PERSON, HELD_QUOTA, HELD_RESTART, TRIPWIRE, TRIPWIRES, WORKSTREAM_RULES } from "../types";
import type { BasisField, Clarity, Escalation, ItemRef, ReadinessStop, ReporterWait, Proposal, ReviewVerdict, Run, WorkItem, Workstream, WorkstreamActor, WorkstreamBasis, WorkstreamBudget, WorkstreamEvent, WorkstreamMode, WorkstreamRule, WorkstreamUndo, WorkstreamView, WorkstreamsChanged } from "../types";
import { startedFresh } from "./mockPipTurns";

const CONNECTION = "mock";
/** Where the sample backend keeps its workstreams and their audit, so both survive a reload. */
/** How long after a hold or a switch of mode it can be undone, as `UNDO_WINDOW_SECS` in `inbox/workstreams.rs`. */
export const UNDO_WINDOW_MS = 60_000;

export const MOCK_WORKSTREAMS_KEY = "gossamr-mock-workstreams";
/** Pip's notes are kept up to this many bytes, after scrubbing (NOTES_LIMIT in src-tauri/src/inbox/workstreams.rs). */
export const NOTES_LIMIT = 2_048;
const TITLE_LIMIT = 200;
/** What a workstream id may be, as `RunSpec::validate` checks it. */
const ID_LIMIT = 64;
/** The markers prompts and Pip's context fence data with; notes holding any of them are refused rather than cleaned. */
export const MARKERS = ["<<<TICKET", "TICKET>>>", "<<<FOCUS", "FOCUS>>>", "<<<PLAN", "PLAN>>>", "<<<BUILD", "BUILD>>>", "<<<FINDINGS", "FINDINGS>>>", "<<<ASSUMPTIONS", "ASSUMPTIONS>>>", "<<<AGENT_OUTPUT", "AGENT_OUTPUT>>>", "<<<PIP_NOTES", "PIP_NOTES>>>"];

/** Parts of an audit line besides who did what. */
export interface EventDetail {
  runId?: string | null;
  proposalId?: string | null;
  digest?: string | null;
  detail?: string | null;
}

interface Stored {
  workstreams: Workstream[];
  events: WorkstreamEvent[];
}

/** Without what doesn't show: control characters except newlines and tabs, and direction and zero-width marks, as `visible` does. */
const visible = (text: string) => text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, "");

/** Control characters out, except newlines and tabs; markers out, as `scrub` does. */
function scrub(text: string): string {
  let out = visible(text.replace(/\r\n/g, "\n"));
  while (MARKERS.some((m) => out.includes(m))) for (const m of MARKERS) out = out.split(m).join("");
  return out;
}

const flat = (text: string) => scrub(text).split(/\s+/).filter(Boolean).join(" ");
const bytes = (text: string) => new TextEncoder().encode(text).length;

/** A stand-in for SHA-256: stable for the same text, different when it changes. */
export function textDigest(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return `mock-${h.toString(16).padStart(8, "0")}`;
}

/** What of a ticket its workstream's basis is taken from. */
export type BasisTicket = Pick<WorkItem, "title" | "body" | "status" | "assignee">;

/** What `ticket` looks like now, kept to notice it drifting later, as `basis_of` in src-tauri/src/inbox/workstreams.rs. */
export function basisOfItem(ticket: BasisTicket): WorkstreamBasis {
  return { statusId: ticket.status.id, assignee: ticket.assignee, summaryDigest: textDigest(ticket.title), descriptionDigest: textDigest(docText(ticket.body)) };
}

/**
 * The fields of `basis` that `ticket` drifted from in a way that invalidates the plan, as `drifted` does: its summary or
 * description changed, or it moved into a Done status other than the basis's. Fields a write is changing are left out,
 * and a basis with no summary digest isn't compared on its summary. Another status or a new assignee doesn't count.
 */
export function driftOf(basis: WorkstreamBasis, ticket: BasisTicket): BasisField[] {
  const now = basisOfItem(ticket);
  const compared = (f: BasisField) => !(basis.changing ?? []).includes(f);
  const fields: BasisField[] = [];
  if (compared("summary") && basis.summaryDigest && basis.summaryDigest !== now.summaryDigest) fields.push("summary");
  if (compared("description") && basis.descriptionDigest !== now.descriptionDigest) fields.push("description");
  if (compared("status") && ticket.status.category === "done" && basis.statusId !== now.statusId) fields.push("status");
  return fields;
}

/** The last tripwire that held a workstream, from its audit: its kind, the basis fields that drifted, when, and when the person resumed it after. */
export interface LastTrip {
  kind: string;
  fields: BasisField[];
  at: string;
  resumedAt: string | null;
}

/** The last tripwire in `events` (oldest first) with its `basis_drifted` fields and the person's first resume after it, as `last_trip`. */
export function lastTripOf(events: readonly WorkstreamEvent[]): LastTrip | null {
  const trip = [...events].reverse().find((e) => e.actor === "supervisor" && e.action === "tripwire");
  if (!trip?.detail || !(TRIPWIRES as readonly string[]).includes(trip.detail)) return null;
  const after = events.filter((e) => e.seq > trip.seq);
  const drift = after.find((e) => e.actor === "supervisor" && e.action === "basis_drifted");
  const fields = (drift?.detail ?? "").split(",").filter((f): f is BasisField => (BASIS_FIELDS as readonly string[]).includes(f));
  const resumed = after.find((e) => e.actor === "person" && e.action === "resumed");
  return { kind: trip.detail, fields, at: trip.at, resumedAt: resumed?.at ?? null };
}

/**
 * The newest finished build among `runs` that pushes a branch, when no review was queued after it and `prOf` finds no
 * pull request for it yet: what a review waits for, as `pushed_build` and `view_of` in src-tauri/src/inbox/workstreams.rs.
 */
export function waitingForPr(runs: readonly Run[], prOf: (runId: string) => number | null): string | null {
  const build = runs.filter((r) => r.spec.kind === "build" && r.state === "done" && r.spec.allowPush).sort(byQueue).pop();
  if (!build) return null;
  if (runs.some((r) => r.spec.kind === "review" && (byQueue(r, build) > 0 || r.spec.buildFromRun === build.id))) return null;
  return prOf(build.id) == null ? build.id : null;
}

/** How many automatic fix rounds run before a review that still blocks is the person's, as `autostart::FIX_ROUNDS_MAX`. */
const FIX_ROUNDS_MAX = 2;

/** Why a choice on a review that still blocks after the fix rounds is refused, as `ESCALATION_GONE` in src-tauri/src/inbox/workstreams.rs. */
export const ESCALATION_GONE = "This review isn't waiting for your choice any more.";

/**
 * The escalation of `ws`, if its newest review still blocks after the automatic fix rounds, as `escalation_of`: the
 * workstream is open and in Manage (a hold doesn't hide it), its newest review is done, blocking and of a build, the
 * supervisor said the rounds ran out for it (`fix_rounds_exhausted`), the person hasn't sent a fix round after it
 * (`fix_round_person`) or taken it over (`escalation_taken`) or posted its review draft as it is (`escalation_posted`), and the build is done. `drafts` are the pending drafts; only GitHub reviews among them count.
 */
export function escalationOf(ws: Workstream, runs: readonly Run[], verdictOf: (run: Run) => ReviewVerdict | null, events: readonly WorkstreamEvent[], drafts: readonly Proposal[]): Escalation | null {
  if (ws.closedAt !== null || ws.mode !== "manage") return null;
  const mine = runs.filter((r) => r.spec.workstream === ws.id);
  const review = mine.filter((r) => r.spec.kind === "review").sort(byQueue).pop();
  if (!review || review.state !== "done" || verdictOf(review) !== "blocking") return null;
  const build = mine.find((r) => r.id === review.spec.buildFromRun && r.spec.kind === "build");
  if (!build || build.state !== "done") return null;
  const exhausted = events.filter((e) => e.action === "fix_rounds_exhausted" && e.runId === review.id).sort((a, b) => a.seq - b.seq).pop();
  if (!exhausted) return null;
  // The person sent a round after it, took it over, or posted its review draft as it is: a later switch back to Manage doesn't bring it back.
  if (events.some((e) => (e.action === "fix_round_person" && e.detail === `after ${review.id}`) || ((e.action === "escalation_taken" || e.action === "escalation_posted") && e.runId === review.id))) return null;
  const reviews = drafts.filter((p) => p.state.type === "pending").flatMap((p) => (p.intent.type === "githubReview" ? [{ p, i: p.intent }] : []));
  const own = reviews.find((d) => d.i.runId === review.id)?.p.id;
  const pr = review.spec.pr;
  // Only this workstream's own drafts, so a draft is offered by at most one escalation, as in Rust.
  const ofPull = pr == null ? undefined : reviews.filter((d) => d.i.number === pr && d.i.repo.toLowerCase() === review.spec.repo.toLowerCase() && workstreamOf(d.p) === ws.id).sort((a, b) => a.p.createdAt.localeCompare(b.p.createdAt) || a.p.id.localeCompare(b.p.id)).pop()?.p.id;
  const labels = new Map(runLabels(mine));
  return {
    reviewRun: review.id,
    buildRun: build.id,
    reviewLabel: labels.get(review.id) ?? "",
    buildLabel: labels.get(build.id) ?? "",
    rounds: FIX_ROUNDS_MAX,
    reviewDraft: own ?? ofPull ?? null,
    at: exhausted.at,
  };
}

/**
 * The clarity notice of `ws`, as `clarity_of`: the ticket reads thin (`gaps`), no Triage ran in the workstream (its verdict
 * is the authority), the person hasn't dismissed or asked about it (unless the ticket changed since they asked), and nothing
 * waits on the reporter. Never a need, so any mode shows it.
 */
export function clarityOf(ws: Workstream, runs: readonly Run[], gaps: readonly ClarityGap[], replies: readonly string[], events: readonly WorkstreamEvent[]): Clarity | null {
  if (ws.closedAt !== null || ws.itemKey === null || !gaps.length) return null;
  if (runs.some((r) => r.spec.workstream === ws.id && r.spec.kind === "triage")) return null;
  const follow = reporterFollow(events, replies);
  const said = (action: string) => events.some((e) => e.actor === "person" && e.action === action);
  if (said("clarity_dismissed") || follow.waiting || (said("clarity_asked") && !follow.changed)) return null;
  return { gaps: [...gaps] };
}

/** Why asking the reporter, or saying a ticket looks fine, is refused when its clarity notice isn't showing, as `CLARITY_GONE`. */
export const CLARITY_GONE = "This ticket isn't flagged as possibly unclear any more.";

/** Why a choice on a Triage that found its ticket not ready is refused, as `READINESS_GONE` in src-tauri/src/inbox/workstreams.rs. */
export const READINESS_GONE = "This ticket isn't waiting for your choice about its open questions any more.";

/**
 * The readiness stop of `ws`, if its newest Triage on a ticket is done and said `Ready to plan: no`, as `readiness_of`: the
 * workstream is open and in Manage, the person hasn't chosen yet (`readiness_asked`, `readiness_answered` or
 * `readiness_overridden`, theirs, naming that Triage), and no Plan was started since it finished. A newer Triage, which
 * is under way or says ready, takes it away, as does a Plan the person started by hand. `readiness` is what a Triage's
 * written answer resolves to; null is no verdict, which reads as ready. A choice to ask the reporter is undone by the ticket
 * changing while the person waited (`reporterFollow(...).changed`): the stop comes back, flagged `changed`.
 */
export function readinessOf(ws: Workstream, runs: readonly Run[], readiness: (run: Run) => { ready: boolean; questions: string[] } | null, replies: readonly string[], events: readonly WorkstreamEvent[]): ReadinessStop | null {
  if (ws.closedAt !== null || ws.mode !== "manage") return null;
  const mine = runs.filter((r) => r.spec.workstream === ws.id);
  const triage = mine.filter((r) => r.spec.kind === "triage" && !!r.item).sort(byQueue).pop();
  if (!triage || triage.state !== "done") return null;
  const found = readiness(triage);
  if (!found || found.ready) return null;
  const chosen = events.some((e) => e.actor === "person" && ["readiness_asked", "readiness_answered", "readiness_overridden"].includes(e.action) && e.runId === triage.id);
  const since = triage.endedAt ?? triage.queuedAt;
  const follow = reporterFollow(events, replies);
  const changed = follow.changed;
  if ((chosen && !changed) || mine.some((r) => r.spec.kind === "plan" && r.queuedAt >= since)) return null;
  return { triageRun: triage.id, triageLabel: new Map(runLabels(mine)).get(triage.id) ?? "", questions: found.questions, at: since, ...(changed ? { changed } : {}), ...(follow.replied ? { replied: true } : {}) };
}

/** Why `id` can't be a workstream id at all, as `RunSpec::validate` refuses it; null when it can. */
export function workstreamIdProblem(id: string): string | null {
  if (!id || [...id].length > ID_LIMIT || /[\u0000-\u001f\u007f]/.test(id)) return "the workstream id must be 1 to 64 characters with no control characters";
  return null;
}

/** Whether `reason` is one a workstream may be held with, as `valid_hold_reason` checks it. */
export function validHoldReason(reason: string): boolean {
  if ([HELD_RESTART, HELD_PERSON, HELD_ALL, HELD_BUDGET, HELD_DAILY, HELD_QUOTA].includes(reason)) return true;
  return reason.startsWith(TRIPWIRE) && (TRIPWIRES as readonly string[]).includes(reason.slice(TRIPWIRE.length));
}

/**
 * Holds `ws` with `reason` as `hold` in src-tauri/src/inbox/workstreams.rs does: not a closed one, and one already held
 * keeps its reason unless the person's hold replaces a restart, budget or quota one. Null when nothing changes.
 */
function held(ws: Workstream, reason: string): Workstream | null {
  if (ws.closedAt !== null) return null;
  // The person's own hold, or a tripwire's, replaces one that would lift by itself or that the person didn't choose.
  const replaces = reason === HELD_PERSON || reason.startsWith(TRIPWIRE);
  if (ws.heldReason !== null && !(replaces && [HELD_RESTART, HELD_BUDGET, HELD_QUOTA].includes(ws.heldReason))) return null;
  return { ...ws, heldReason: reason };
}

/**
 * `ws` held for its budget when it is in Manage, open, not held and has used its automatic steps up, as `rehold_spent`
 * does: Allow 5 more is the only way to grant more, so going back to Manage can't skip the question. Null otherwise.
 */
function reheldForBudget(ws: Workstream): Workstream | null {
  if (ws.closedAt !== null || ws.mode !== "manage" || ws.heldReason !== null || budgetLevel(ws) !== "spent") return null;
  return { ...ws, heldReason: HELD_BUDGET };
}

let restartTaken = false;

/** True for the first store opened on a page that started the app afresh, false for any other: a page restarts once. */
export function restartOnce(): boolean {
  if (restartTaken) return false;
  restartTaken = true;
  return startedFresh();
}

/** A stored workstream from before rules and basis were kept, with their defaults. */
const withDefaults = (w: Workstream): Workstream => ({
  ...w,
  heldReason: w.heldReason ?? null,
  budget: w.budget ?? { autoTurns: null, wakes: null, tokens: null },
  spent: w.spent ?? { autoTurns: 0, wakes: 0, tokens: 0 },
  rules: w.rules ?? {},
  basis: w.basis ?? null,
});

const isWorkstream = (w: unknown): w is Workstream => {
  const x = w as Partial<Workstream> | null;
  return !!x && typeof x.id === "string" && typeof x.title === "string" && typeof x.createdAt === "string";
};

const isEvent = (e: unknown): e is WorkstreamEvent => {
  const x = e as Partial<WorkstreamEvent> | null;
  return !!x && typeof x.workstreamId === "string" && typeof x.seq === "number" && typeof x.action === "string";
};

/**
 * The sample backend's workstreams, kept in this browser so they survive a reload as the app's database keeps them.
 * The stage is never kept: it is worked out from the runs linked to each one (`runs`) every time one is read, as the
 * backend does. Opened after a restart, every open workstream is held, as reopening the app's database holds them.
 * Nothing here starts, stops or answers a run or writes to Jira.
 */
export class MockWorkstreams {
  private all: Workstream[] = [];
  private audit: WorkstreamEvent[] = [];
  private listeners = new Set<(c: WorkstreamsChanged) => void>();
  private seq = 0;
  /** The number of the pull request run `runId` opened, as far as the code host shows it; set by the backend that owns the code. */
  prOf: (runId: string) => number | null = () => null;
  /** A finished review's verdict as its sheet resolves it, null without one; set by the backend that owns the runs. */
  verdictOf: (run: Run) => ReviewVerdict | null = () => null;
  /** A cached ticket as it is now, by key, which a workstream's basis is taken from; set by the backend that owns the tickets. */
  ticketOf: (key: string) => BasisTicket | null = () => null;
  /** The times of the comments on a ticket from anyone but the signed-in person, by key: the reporter's replies, which leave no audit line; set by the backend that owns the tickets. */
  repliesTo: (key: string) => string[] = () => [];
  /** The reporter's replies on `ws`'s ticket (`repliesTo`); none for a workstream without one. */
  repliesOf(ws: Pick<Workstream, "itemKey" | "closedAt">): string[] {
    return ws.itemKey && ws.closedAt === null ? this.repliesTo(ws.itemKey) : [];
  }
  /** The pending drafts there are, of which an escalation offers a GitHub review to post as it is; set by the backend that owns the drafts. */
  pendingDrafts: () => readonly Proposal[] = () => [];
  /** A finished Triage's verdict on its ticket as its written answer gives it, null without one; set by the backend that owns the runs. */
  readinessOfRun: (run: Run) => { ready: boolean; questions: string[] } | null = () => null;

  /**
   * `runs` lists the runs there are, `titleOf` the title of a cached ticket (null when it isn't cached). `now` is the
   * clock, fixed in tests. `restart` says the app started afresh rather than the page reloading.
   */
  constructor(
    private readonly runs: () => readonly Run[],
    private readonly titleOf: (item: ItemRef) => string | null,
    private readonly now: () => Date = () => new Date(),
    private readonly key: string = MOCK_WORKSTREAMS_KEY,
    restart: boolean = restartOnce(),
    /** The mode a new workstream opens in; `?wsManage=1` makes it Manage, for trying the supervisor. */
    private readonly openMode: WorkstreamMode = "advise",
  ) {
    const stored = readStored(key) as Partial<Stored> | null;
    this.all = Array.isArray(stored?.workstreams) ? stored.workstreams.filter(isWorkstream).map(withDefaults) : [];
    this.audit = Array.isArray(stored?.events) ? stored.events.filter(isEvent) : [];
    this.seq = Math.max(0, ...this.all.map((w) => Number(/^ws-(\d+)$/.exec(w.id)?.[1] ?? 0)));
    if (restart) this.holdOpen(HELD_RESTART);
  }

  /** Holds every open workstream not held already, each with one supervisor line, as `hold_open_workstreams` does. */
  private holdOpen(reason: string) {
    let any = false;
    for (const ws of this.all) {
      if (ws.closedAt !== null || ws.heldReason !== null) continue;
      this.put({ ...ws, heldReason: reason });
      this.append(ws.id, "supervisor", "held", { detail: reason });
      any = true;
    }
    if (any) this.save();
  }

  private save() {
    writeStored(this.key, { workstreams: this.all, events: this.audit } satisfies Stored);
  }

  /** Tells listeners something changed, including a run that may have moved a stage on. */
  changed() {
    this.listeners.forEach((l) => l({ connectionId: CONNECTION }));
  }

  onChanged(listener: (c: WorkstreamsChanged) => void) {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  private owned(id: string): Workstream {
    const ws = this.all.find((w) => w.id === id);
    if (!ws) throw new Error(`there is no workstream ${id}`);
    return ws;
  }

  private put(ws: Workstream) {
    this.all = this.all.map((w) => (w.id === ws.id ? ws : w));
  }

  private view(ws: Workstream, runs: readonly Run[]): WorkstreamView {
    const linked = runs.filter((r) => r.spec.workstream === ws.id).sort((a, b) => byQueue(b, a));
    const judged = linked.map((r) => ({ ...r, verdict: r.spec.kind === "review" && r.state === "done" ? this.verdictOf(r) : null }));
    const view: WorkstreamView = { workstream: ws, stage: stage(judged), runs: linked.map((r) => r.id), labels: runLabels(linked), budget: budgetView(ws) };
    const waiting = waitingForPr(linked, this.prOf);
    // The audit is read only for an open workstream, as `escalation_events` does; each reading checks the mode itself.
    const events = ws.closedAt === null ? this.audit.filter((e) => e.workstreamId === ws.id) : [];
    const escalation = events.length ? escalationOf(ws, linked, (r) => (r.spec.kind === "review" && r.state === "done" ? this.verdictOf(r) : null), events, this.pendingDrafts()) : null;
    const replies = this.repliesOf(ws);
    const readiness = events.length ? readinessOf(ws, linked, (r) => (r.spec.kind === "triage" && r.state === "done" ? this.readinessOfRun(r) : null), replies, events) : null;
    const ticket = ws.closedAt === null && ws.itemKey ? this.ticketOf(ws.itemKey) : null;
    const clarity = ticket ? clarityOf(ws, linked, clarityGaps(docText(ticket.body)), replies, events) : null;
    const follow = ws.closedAt === null ? reporterFollow(events, replies) : null;
    const waitingOnReporter: ReporterWait | null = follow?.waiting ? { since: follow.waiting } : null;
    const changedWhileWaiting = !!follow?.changed;
    const reporterReplied = !!follow?.replied;
    return { ...view, ...(waiting ? { waitingForPr: waiting } : {}), ...(reviewBlocking(judged) ? { reviewBlocking: true } : {}), ...(escalation ? { escalation } : {}), ...(readiness ? { readiness } : {}), ...(clarity ? { clarity } : {}), ...(waitingOnReporter ? { waitingOnReporter } : {}), ...(changedWhileWaiting ? { changedWhileWaiting } : {}), ...(reporterReplied ? { reporterReplied } : {}) };
  }

  /** Opens a workstream on a cached ticket, or with no ticket and a title. A ticket with an open one gets that one back, unchanged. */
  open(item: ItemRef | null, title: string | null = null): Workstream {
    if (item && item.connectionId !== CONNECTION) throw new Error("that item belongs to another connection");
    const named = title === null ? "" : flat(title);
    let itemKey: string | null = null;
    let basis: WorkstreamBasis | null = null;
    let made: string;
    if (item) {
      const open = this.forItem(item.key);
      if (open) return open;
      const work = this.titleOf(item);
      if (work === null) throw new Error(`${item.key} isn't in the cache, so there is nothing to base a workstream on`);
      itemKey = item.key;
      const ticket = this.ticketOf(item.key);
      basis = ticket ? basisOfItem(ticket) : null;
      made = named || flat(`${item.key} ${work}`);
    } else {
      if (!named) throw new Error("a workstream with no ticket needs a title");
      made = named;
    }
    const at = this.now().toISOString();
    const ws: Workstream = {
      id: `ws-${++this.seq}`,
      connectionId: CONNECTION,
      itemKey,
      repo: null,
      title: [...made].slice(0, TITLE_LIMIT).join(""),
      pipSession: null,
      mode: this.openMode,
      heldReason: null,
      notes: null,
      createdAt: at,
      closedAt: null,
      budget: { autoTurns: null, wakes: null, tokens: null },
      spent: { autoTurns: 0, wakes: 0, tokens: 0 },
      rules: {},
      basis,
    };
    this.all = [ws, ...this.all];
    this.append(ws.id, "person", "opened");
    this.save();
    this.changed();
    return ws;
  }

  /** The open workstream on the ticket `key`, if there is one. */
  forItem(key: string): Workstream | null {
    return this.all.find((w) => w.itemKey === key && w.closedAt === null) ?? null;
  }

  get(id: string): WorkstreamView | null {
    const ws = this.all.find((w) => w.id === id);
    return ws ? this.view(ws, this.runs()) : null;
  }

  /** Newest first, each with its stage; closed ones only when asked for. */
  list(includeClosed = false): WorkstreamView[] {
    const runs = this.runs();
    return this.all
      .filter((w) => includeClosed || w.closedAt === null)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
      .map((w) => this.view(w, runs));
  }

  /** Closes a workstream; its runs and drafts stay as they are. Closing it again changes nothing. */
  close(id: string): Workstream {
    const ws = this.owned(id);
    if (ws.closedAt !== null) return ws;
    const next = { ...ws, closedAt: this.now().toISOString() };
    this.put(next);
    this.append(id, "person", "closed");
    this.save();
    this.changed();
    return next;
  }

  /** Replaces the notes of an open workstream, as `Core::set_workstream_notes` does: markers refused, scrubbed, at most 2 KB; blank clears. Only the digest and size are audited. */
  setNotes(id: string, notes: string, actor: WorkstreamActor = "person"): Workstream {
    // As written and with what doesn't show taken out, so a marker split by a zero-width space is refused too.
    if (MARKERS.some((m) => notes.includes(m) || visible(notes).includes(m))) throw new Error("notes can't contain Gossamr's data markers");
    const clean = scrub(notes).trim();
    if (bytes(clean) > NOTES_LIMIT) throw new Error(`notes are limited to ${NOTES_LIMIT} bytes`);
    const ws = this.owned(id);
    if (ws.closedAt !== null) throw new Error(`workstream ${id} is closed`);
    const kept = clean || null;
    if (ws.notes === kept) return ws;
    const next = { ...ws, notes: kept };
    this.put(next);
    const text = kept ?? "";
    this.append(id, actor, "notes_set", { digest: textDigest(text), detail: String(bytes(text)) });
    this.save();
    this.changed();
    return next;
  }

  /** An open workstream, to change; a closed one is refused. */
  private openOne(id: string): Workstream {
    const ws = this.owned(id);
    if (ws.closedAt !== null) throw new Error(`workstream ${id} is closed`);
    return ws;
  }

  private changedTo(next: Workstream, actor: WorkstreamActor, action: string, extra: EventDetail = {}): Workstream {
    this.put(next);
    this.append(next.id, actor, action, extra);
    this.save();
    this.changed();
    return next;
  }

  /**
   * Sets how much Pip may do on its own, as `set_workstream_mode` does; the same mode records nothing. The person setting
   * it forgets the mode a tripwire took away (`resumeMode`), so resuming leaves their choice. Changing to Manage while not
   * held and with the automatic steps used up holds it for its budget again (a supervisor `held` line), so Allow 5 more is
   * asked again rather than skipped.
   */
  setMode(id: string, mode: WorkstreamMode, actor: WorkstreamActor = "person"): Workstream {
    let ws = this.openOne(id);
    if (actor === "person" && ws.resumeMode) {
      const { resumeMode: _, ...rest } = ws;
      ws = rest;
      this.put(ws);
      this.save();
    }
    if (ws.mode === mode) return ws;
    const reheld = reheldForBudget({ ...ws, mode });
    const changed = this.changedTo(reheld ?? { ...ws, mode }, actor, "mode_set", { detail: mode });
    if (reheld) this.record(id, "supervisor", "held", { detail: HELD_BUDGET });
    return changed;
  }

  /** The workstream and review whose escalation offers draft `draftId` to post as it is, or null: read before the post, while the draft is still pending. */
  escalationOffering(draftId: string): { workstream: string; reviewRun: string } | null {
    const found = this.list().find((v) => v.escalation?.reviewDraft === draftId);
    return found?.escalation ? { workstream: found.workstream.id, reviewRun: found.escalation.reviewRun } : null;
  }

  /** The person posted the review draft `draftId` its escalation offered, as `escalation_posted`: records it, and the escalation is resolved. */
  escalationPosted(workstream: string, reviewRun: string, draftId: string) {
    this.record(workstream, "person", "escalation_posted", { runId: reviewRun, proposalId: draftId });
  }

  /**
   * The person's "I'll take it from here" on a review that still blocks after the automatic fix rounds, as
   * `take_over_escalation`: records `escalation_taken` and switches the workstream to Advise. Nothing else changes.
   * Refused with `ESCALATION_GONE` unless the workstream's escalation is about `reviewRun`.
   */
  takeOver(id: string, reviewRun: string): Workstream {
    const view = this.get(id);
    if (!view) throw new Error(`there is no workstream ${id}`);
    if (view.escalation?.reviewRun !== reviewRun) throw new Error(ESCALATION_GONE);
    this.append(id, "person", "escalation_taken", { runId: reviewRun });
    return this.setMode(id, "advise", "person");
  }

  /** The readiness stop of workstream `id` as it stands, refused with `READINESS_GONE` unless it is about `triage`, as `readiness_stop`. */
  readinessStop(id: string, triage: string): ReadinessStop {
    const view = this.get(id);
    if (!view) throw new Error(`there is no workstream ${id}`);
    if (view.readiness?.triageRun !== triage) throw new Error(READINESS_GONE);
    return view.readiness;
  }

  /**
   * The person's "I'll answer" on a Triage that found its ticket not ready, as `answer_readiness`: records
   * `readiness_answered`, which settles the stop. Nothing starts. Refused with `READINESS_GONE` unless the stop is about `triage`.
   */
  answerReadiness(id: string, triage: string): Workstream {
    this.readinessStop(id, triage);
    this.record(id, "person", "readiness_answered", { runId: triage });
    return this.owned(id);
  }

  /**
   * The person's "Plan anyway" on a Triage that found its ticket not ready, as `override_readiness`: records
   * `readiness_overridden`, the one line that lets the Triage-to-Plan rule start the Plan, which then still needs the
   * workstream in Manage, not held, within budget. Refused with `READINESS_GONE` unless the stop is about `triage`.
   */
  overrideReadiness(id: string, triage: string): Workstream {
    this.readinessStop(id, triage);
    this.record(id, "person", "readiness_overridden", { runId: triage });
    return this.owned(id);
  }

  /** The clarity notice of workstream `id` as it stands, refused with `CLARITY_GONE` when it isn't showing, as `clarity_notice`. */
  clarityNotice(id: string): Clarity {
    const view = this.get(id);
    if (!view) throw new Error(`there is no workstream ${id}`);
    if (!view.clarity) throw new Error(CLARITY_GONE);
    return view.clarity;
  }

  /** Records `clarity_asked` (the person's, naming the draft they asked for), as `ask_reporter_now` does after drafting. */
  askedClarity(id: string, proposalId: string) {
    this.record(id, "person", "clarity_asked", { proposalId });
  }

  /** The person's "Looks fine", as `dismiss_clarity`: records `clarity_dismissed`, so the notice doesn't show for the ticket again. */
  dismissClarity(id: string): Workstream {
    this.clarityNotice(id);
    this.record(id, "person", "clarity_dismissed");
    return this.owned(id);
  }

  /** Records `readiness_asked` (the person's, naming the Triage and the draft they asked for), as `ask_reporter` does after drafting. */
  askedReporter(id: string, triage: string, proposalId: string) {
    this.record(id, "person", "readiness_asked", { runId: triage, proposalId });
  }

  /** Holds an open workstream, as `hold_workstream` does: an existing reason is kept unless the person's hold replaces a restart, budget or quota one. */
  hold(id: string, reason: string = HELD_PERSON, actor: WorkstreamActor = "person"): Workstream {
    if (!validHoldReason(reason)) throw new Error(`"${reason}" isn't a reason to hold a workstream`);
    const ws = this.openOne(id);
    const next = held(ws, reason);
    return next ? this.changedTo(next, actor, "held", { detail: reason }) : ws;
  }

  /**
   * Lifts a workstream's hold, as `resume_workstream` does; what was spent is kept, whatever the hold (a budget hold is
   * lifted without granting steps, so Manage holds it again), and lifting a basis-drift hold takes the basis again from the
   * ticket as it is now (`basis_captured`). Resuming puts back the mode a tripwire took away (`mode_set` by the person),
   * whatever the hold, unless the person chose one meanwhile; a restored Manage on a spent budget is held again.
   */
  resume(id: string): Workstream {
    const ws = this.openOne(id);
    if (ws.heldReason === null) return ws;
    const rebase = ws.heldReason === `${TRIPWIRE}basis_drift`;
    // Whatever the hold, as a trip can land while another is on.
    const restore = ws.resumeMode ?? null;
    const { resumeMode: _, ...kept } = ws;
    let next: Workstream = { ...kept, heldReason: null, mode: restore ?? ws.mode };
    if (rebase) {
      const ticket = ws.itemKey ? this.ticketOf(ws.itemKey) : null;
      const { drifted: _, ...rest } = next;
      next = { ...rest, basis: ticket ? basisOfItem(ticket) : null };
    }
    const reheld = reheldForBudget(next);
    if (reheld) next = reheld;
    this.changedTo(next, "person", "resumed", { detail: ws.heldReason });
    if (restore) this.record(id, "person", "mode_set", { detail: restore });
    if (rebase && next.basis) this.record(id, "supervisor", "basis_captured");
    if (reheld) this.record(id, "supervisor", "held", { detail: HELD_BUDGET });
    return next;
  }

  /**
   * The person's "Allow 5 more", as `allow_more_steps` does: raises the automatic turns and wakes allowance by
   * `ALLOW_MORE_STEPS` and lifts the hold, keeping what was spent (`steps_allowed` and `resumed`, the person's). Refused
   * unless the workstream is held for its budget, so a stale choice changes nothing.
   */
  allowMore(id: string): Workstream {
    const ws = this.openOne(id);
    if (ws.heldReason !== HELD_BUDGET) throw new Error("this workstream isn't held for its automatic steps");
    const { autoTurns, wakes } = budgetView(ws);
    const next: Workstream = { ...ws, heldReason: null, budget: { ...ws.budget, autoTurns: autoTurns.limit + ALLOW_MORE_STEPS, wakes: wakes.limit + ALLOW_MORE_STEPS } };
    this.changedTo(next, "person", "steps_allowed", { detail: String(ALLOW_MORE_STEPS) });
    this.record(id, "person", "resumed", { detail: HELD_BUDGET });
    return next;
  }

  /**
   * The person's Undo of a hold or of a switch of mode, as `undo_workstream` does: only while that change is the last line of
   * the audit, the person's, under `UNDO_WINDOW_MS` old, and the workstream still stands as it left it. It adds an `undone`
   * line naming what it took back; the line it follows stays.
   */
  undo(id: string, undo: WorkstreamUndo): Workstream {
    const ws = this.openOne(id);
    const events = this.events(id);
    const last = events[events.length - 1];
    const gone = () => new Error("That change can't be undone any more: something else happened since, or it was a while ago.");
    const fresh = !!last && last.actor === "person" && this.now().getTime() - Date.parse(last.at) <= UNDO_WINDOW_MS;
    if (undo.type === "hold") {
      if (!fresh || last!.action !== "held" || !last!.detail || last!.detail !== ws.heldReason) throw gone();
      if ((undo.was !== null && !validHoldReason(undo.was)) || undo.was === ws.heldReason) throw new Error("That isn't a hold to go back to.");
      return this.changedTo({ ...ws, heldReason: undo.was }, "person", "undone", { detail: "held" });
    }
    if (!fresh || last!.action !== "mode_set" || last!.detail !== ws.mode) throw gone();
    if (undo.was === ws.mode) throw new Error("The workstream is in that mode already.");
    const { resumeMode: _, ...rest } = ws;
    return this.changedTo({ ...rest, mode: undo.was, ...(undo.resumeMode ? { resumeMode: undo.resumeMode } : {}) }, "person", "undone", { detail: "mode_set" });
  }

  /**
   * The fields workstream `id`'s ticket drifted from its basis, as `workstream_basis_drift`: a workstream with no basis
   * yet has it taken now and hasn't drifted; null with nothing to compare (no ticket, or not cached).
   */
  basisDrift(id: string): BasisField[] | null {
    const ws = this.owned(id);
    const ticket = ws.itemKey ? this.ticketOf(ws.itemKey) : null;
    if (!ticket) return null;
    if (ws.basis) return driftOf(ws.basis, ticket);
    this.changedTo({ ...ws, basis: basisOfItem(ticket) }, "supervisor", "basis_captured");
    return [];
  }

  /**
   * Once a draft the person approved in workstream `id` wrote `fields` of its ticket, the basis takes those fields again
   * from the ticket as the write left it, as `capture_workstream_basis` after a write; the others are still compared.
   */
  rebase(id: string, fields: readonly BasisField[]) {
    const ws = this.all.find((w) => w.id === id && w.closedAt === null);
    const ticket = ws?.itemKey ? this.ticketOf(ws.itemKey) : null;
    if (!ws || !ticket || (ws.basis && !fields.length)) return;
    const now = basisOfItem(ticket);
    const old = ws.basis;
    const basis: WorkstreamBasis = old
      ? {
          statusId: fields.includes("status") ? now.statusId : old.statusId,
          assignee: old.assignee,
          summaryDigest: fields.includes("summary") ? now.summaryDigest : old.summaryDigest,
          descriptionDigest: fields.includes("description") ? now.descriptionDigest : old.descriptionDigest,
        }
      : now;
    if (JSON.stringify(basis) === JSON.stringify(old)) return;
    this.changedTo({ ...ws, basis }, "supervisor", "basis_captured");
  }

  /** The person's switch for one auto-start rule, as `set_workstream_rule` does; null follows the global switch again. */
  setRule(id: string, rule: WorkstreamRule, on: boolean | null): Workstream {
    if (!WORKSTREAM_RULES.includes(rule)) throw new Error(`there is no auto-start rule "${rule}"`);
    const ws = this.openOne(id);
    if ((ws.rules[rule] ?? null) === on) return ws;
    const rules = { ...ws.rules };
    if (on === null) delete rules[rule];
    else rules[rule] = on;
    return this.changedTo({ ...ws, rules }, "person", "rule_set", { detail: `${rule}=${on === null ? "inherit" : on ? "on" : "off"}` });
  }

  /** The person's Hold all, as `hold_all_workstreams` does: every open workstream not held already. Returns those it held. */
  holdAll(): Workstream[] {
    const now: Workstream[] = [];
    for (const ws of this.all) {
      const next = held(ws, HELD_ALL);
      if (!next) continue;
      this.put(next);
      this.append(ws.id, "person", "held", { detail: HELD_ALL });
      now.push(next);
    }
    if (now.length) {
      this.save();
      this.changed();
    }
    return now;
  }

  /** Sets a workstream's own limits for automatic turns and wakes, for tests and for trying the budget; null is the default. */
  setBudget(id: string, budget: Partial<Pick<WorkstreamBudget, "autoTurns" | "wakes">>): Workstream {
    const ws = this.openOne(id);
    const next: Workstream = { ...ws, budget: { ...ws.budget, ...budget } };
    this.put(next);
    this.save();
    this.changed();
    return next;
  }

  /**
   * The person wrote in the workstream's conversation, as `person_wrote_in_workstream` records it: the automatic turns
   * count from zero again (`budget_reset`), and a hold for a used-up budget is lifted unless the wakes still use it up.
   * Only a person's message does this.
   */
  personWrote(id: string) {
    const ws = this.all.find((w) => w.id === id && w.closedAt === null);
    if (!ws) return;
    const reset = ws.spent.autoTurns > 0;
    const spent = { ...ws.spent, autoTurns: 0 };
    // The wakes may still use the budget up, and then the hold stays.
    const resumed = ws.heldReason === HELD_BUDGET && budgetLevel({ ...ws, spent }) !== "spent";
    if (!reset && !resumed) return;
    this.put({ ...ws, heldReason: resumed ? null : ws.heldReason, spent });
    if (resumed) this.append(id, "person", "resumed", { detail: HELD_BUDGET });
    if (reset) this.append(id, "person", "budget_reset", { detail: "message" });
    this.save();
    this.changed();
  }

  /**
   * Lets the facts `woken` (run and state key) wake Pip in workstream `id`, as `admit_wake` does once the supervisor
   * decided (`decision`): each gets a supervisor `wake` line, and a new turn (`spend`) uses one automatic turn and one
   * wake, with `budget` lines as amber and spent are reached. A decision to hold holds it with a supervisor line. True
   * when Pip is to be woken.
   */
  admitWake(id: string, woken: { run: string; key: string }[], decision: { wake: boolean; hold: string | null }, spend: boolean): boolean {
    const ws = this.all.find((w) => w.id === id && w.closedAt === null);
    if (!ws || !woken.length) return false;
    if (!decision.wake) {
      if (!decision.hold) return false;
      this.put({ ...ws, heldReason: decision.hold });
      this.append(id, "supervisor", "held", { detail: decision.hold });
      this.save();
      this.changed();
      return false;
    }
    for (const f of woken) this.append(id, "supervisor", "wake", { runId: f.run, detail: f.key });
    if (spend) {
      const before = budgetLevel(ws);
      const next: Workstream = { ...ws, spent: { ...ws.spent, autoTurns: ws.spent.autoTurns + 1, wakes: ws.spent.wakes + 1 }, heldReason: decision.hold ?? ws.heldReason };
      this.put(next);
      const after = budgetView(next);
      if (after.level !== before && after.level !== "ok") {
        this.append(id, "supervisor", "budget", { detail: `${after.level} ${after.autoTurns.used}/${after.autoTurns.limit} turns ${after.wakes.used}/${after.wakes.limit} wakes` });
      }
      if (decision.hold) this.append(id, "supervisor", "held", { detail: decision.hold });
    }
    this.save();
    this.changed();
    return true;
  }

  /**
   * A tripwire fired, as `trip_workstream` records it: the tripwire line with its kind (and run), the workstream drops to
   * Advise and is held with `tripwire:<kind>`. A basis drift records the fields that drifted (`basis_drifted`, kept in
   * `drifted` while held) and keeps the basis until the person resumes. The mode it dropped from is kept in `resumeMode`
   * for resuming to put back.
   */
  trip(id: string, kind: string, runId: string | null, drifted: readonly BasisField[] = []): Workstream {
    const reason = `${TRIPWIRE}${kind}`;
    if (!validHoldReason(reason)) throw new Error(`there is no tripwire "${kind}"`);
    let ws = this.openOne(id);
    this.append(id, "supervisor", "tripwire", { runId, detail: kind });
    if (kind === "basis_drift" && drifted.length) this.append(id, "supervisor", "basis_drifted", { detail: drifted.join(",") });
    if (ws.mode !== "advise") {
      // Held already (by the person, say), the trip still takes Manage away, and resuming that hold puts it back.
      ws = { ...ws, mode: "advise", resumeMode: ws.resumeMode ?? ws.mode };
      this.append(id, "supervisor", "mode_set", { detail: "advise" });
    }
    const next = held(ws, reason);
    if (next) {
      ws = next;
      this.append(id, "supervisor", "held", { detail: reason });
    }
    if (kind === "basis_drift" && ws.heldReason === reason) ws = { ...ws, drifted: [...drifted] };
    this.put(ws);
    this.save();
    this.changed();
    return ws;
  }

  /** A workstream's audit, oldest first. */
  events(id: string): WorkstreamEvent[] {
    this.owned(id);
    return this.audit.filter((e) => e.workstreamId === id).sort((a, b) => a.seq - b.seq);
  }

  private append(id: string, actor: WorkstreamActor, action: string, extra: EventDetail = {}): WorkstreamEvent {
    const seq = this.audit.filter((e) => e.workstreamId === id).reduce((n, e) => Math.max(n, e.seq + 1), 0);
    const event: WorkstreamEvent = {
      workstreamId: id,
      seq,
      at: this.now().toISOString(),
      actor,
      action,
      runId: extra.runId ?? null,
      proposalId: extra.proposalId ?? null,
      digest: extra.digest ?? null,
      detail: extra.detail ? [...extra.detail].slice(0, NOTES_LIMIT).join("") : null,
    };
    this.audit = [...this.audit, event];
    return event;
  }

  /** Appends an audit line to workstream `id`; records nothing for a workstream that doesn't exist, as the backend's audit of drafts does. */
  record(id: string | null | undefined, actor: WorkstreamActor, action: string, extra: EventDetail = {}): WorkstreamEvent | null {
    if (!id || !this.all.some((w) => w.id === id)) return null;
    const event = this.append(id, actor, action, extra);
    this.save();
    this.changed();
    return event;
  }

  /**
   * Adds an audit line to workstream `id` as of `at`, for the dev handle (`__gossamrMock.seedWorkstreamEvent`): the sample's
   * clock is the browser's, which a test can't move, so what ages is seeded instead. Nothing here is a thing the person did.
   */
  seedEvent(id: string, actor: WorkstreamActor, action: string, at: string, extra: EventDetail = {}): WorkstreamEvent {
    this.owned(id);
    if (Number.isNaN(Date.parse(at))) throw new Error(`"${at}" isn't a time`);
    const event = { ...this.append(id, actor, action, extra), at: new Date(at).toISOString() };
    this.audit = this.audit.map((e) => (e.workstreamId === id && e.seq === event.seq ? event : e));
    this.save();
    this.changed();
    return event;
  }

  /** Opens workstream `id` `days` days earlier than it did: its `createdAt` and its `opened` line move back, for the dev handle. */
  backdate(id: string, days: number) {
    const ws = this.owned(id);
    const back = (iso: string) => new Date(Date.parse(iso) - days * 86_400_000).toISOString();
    this.put({ ...ws, createdAt: back(ws.createdAt) });
    this.audit = this.audit.map((e) => (e.workstreamId === id && e.action === "opened" ? { ...e, at: back(e.at) } : e));
    this.save();
    this.changed();
  }

  /** Whether the audit names run `id`. */
  namesRun(id: string): boolean {
    return this.audit.some((e) => e.runId === id);
  }

  /** Why a run on `item` (or on no ticket) can't be linked to workstream `id`, as `require_linkable` refuses it; null when it can. */
  linkProblem(id: string, item: ItemRef | null): string | null {
    const shape = workstreamIdProblem(id);
    if (shape) return shape;
    const ws = this.all.find((w) => w.id === id);
    if (!ws) return `there is no workstream ${id}`;
    if (ws.closedAt !== null) return `workstream ${id} is closed`;
    if (ws.itemKey !== (item?.key ?? null)) return `workstream ${id} is about another ticket`;
    return null;
  }
}
