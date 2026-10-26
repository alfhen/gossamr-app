import { docText } from "../lib/docs";
import { followWithReply, NUDGE_GONE, nudgeOffered, reporterFollow, reporterReplies as reporterRepliesOf } from "../lib/reporterWait";
import { clarityGaps, type ClarityGap } from "../lib/ticketClarity";
import { workstreamOf } from "../lib/proposals";
import { adoptableOf, adoptWords, NOTHING_TO_ADOPT } from "../lib/workstreamAdopt";
import { byQueue, reviewBlocking, runLabels, stage } from "../lib/workstreamStage";
import { readStored, writeStored } from "../workspace/storage";
import { BASIS_FIELDS } from "../types";
import type { Adoptable, BasisField, Clarity, ItemRef, PauseReason, ReadinessStop, ReporterReply, ReporterWait, Proposal, ReviewVerdict, Run, WorkItem, Workstream, WorkstreamActor, WorkstreamBasis, WorkstreamEvent, WorkstreamUndo, WorkstreamView, WorkstreamsChanged } from "../types";

const CONNECTION = "mock";
/** Where the sample backend keeps its workstreams and their audit, so both survive a reload. */
/** How long after "Bring them here" it can be undone, as `UNDO_WINDOW_SECS` in `inbox/workstreams.rs`. */
export const UNDO_WINDOW_MS = 60_000;

/** Wakes of Pip one workstream may have in a day, counted from midnight or the person's last resume, and wake turns Pip may have in a day across workstreams, as `WAKES_PER_WORKSTREAM_PER_DAY` and `WAKE_TURNS_PER_DAY` in src-tauri/src/domain/workstream.rs. */
export const WAKES_PER_WORKSTREAM_PER_DAY = 24;
export const WAKE_TURNS_PER_DAY = 120;

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

/** The last time a workstream's ticket changed in Jira, from its audit: the basis fields that drifted and when, as `LastDrift` in src-tauri/src/agent/workstream.rs. */
export interface LastDrift {
  fields: BasisField[];
  at: string;
}

/** The last `basis_drifted` line by the supervisor in `events` (oldest first), as `last_drift`; fields not known are left out. */
export function lastDriftOf(events: readonly WorkstreamEvent[]): LastDrift | null {
  const line = [...events].reverse().find((e) => e.actor === "supervisor" && e.action === "basis_drifted");
  if (!line) return null;
  return { fields: (line.detail ?? "").split(",").filter((f): f is BasisField => (BASIS_FIELDS as readonly string[]).includes(f)), at: line.at };
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

/**
 * The clarity notice of `ws`, as `clarity_of`: the ticket reads thin (`gaps`), no Triage ran in the workstream (its verdict
 * is the authority), no Triage, Plan or Build ran on the ticket anywhere (`itemRuns`: in any workstream or in General), the person hasn't dismissed or asked about it (unless the ticket changed since they asked), and nothing
 * waits on the reporter. Never a need.
 */
export function clarityOf(ws: Workstream, runs: readonly Run[], itemRuns: readonly Run[], gaps: readonly ClarityGap[], replies: readonly string[], events: readonly WorkstreamEvent[]): Clarity | null {
  if (ws.closedAt !== null || ws.itemKey === null || !gaps.length) return null;
  if (runs.some((r) => r.spec.workstream === ws.id && r.spec.kind === "triage")) return null;
  if (itemRuns.some((r) => r.item?.key === ws.itemKey && (r.spec.kind === "triage" || r.spec.kind === "plan" || r.spec.kind === "build"))) return null;
  const follow = reporterFollow(events, replies);
  const said = (action: string) => events.some((e) => e.actor === "person" && e.action === action);
  // An ask whose draft was skipped or retired was never posted, so it doesn't settle the notice.
  const asked = events.some((e) => e.actor === "person" && e.action === "clarity_asked" && !(e.proposalId && draftLapsed(events, e.proposalId)));
  if (said("clarity_dismissed") || follow.waiting || (asked && !follow.changed)) return null;
  return { gaps: [...gaps] };
}

/** Whether the draft `id` was last skipped (and not brought back by Undo) or retired, so it won't be posted. */
function draftLapsed(events: readonly WorkstreamEvent[], id: string): boolean {
  let lapsed = false;
  for (const e of events) {
    if (e.proposalId !== id) continue;
    if (e.action === "draft_skipped" || e.action === "draft_retired") lapsed = true;
    else if (e.action === "undone" && e.detail === "draft_skipped") lapsed = false;
  }
  return lapsed;
}

/** Why asking the reporter, or saying a ticket looks fine, is refused when its clarity notice isn't showing, as `CLARITY_GONE`. */
export const CLARITY_GONE = "This ticket isn't flagged as possibly unclear any more.";

/** The parts of the clarity learning the page may audit, as `CLARITY_NOTES` in src-tauri/src/inbox/workstreams.rs. */
export const CLARITY_NOTES: readonly string[] = ["clarity_learned", "clarity_reset"];

/** Why a choice on a Triage that found its ticket not ready is refused, as `READINESS_GONE` in src-tauri/src/inbox/workstreams.rs. */
export const READINESS_GONE = "This ticket isn't waiting for your choice about its open questions any more.";

/**
 * The readiness stop of `ws`, if its newest Triage on a ticket is done and said `Ready to plan: no`, as `readiness_of`: the
 * workstream is open, the person hasn't chosen yet (`readiness_asked`, `readiness_answered` or
 * `readiness_overridden`, theirs, naming that Triage), and no Plan was started since it finished. A newer Triage, which
 * is under way or says ready, takes it away, as does a Plan the person started by hand. `readiness` is what a Triage's
 * written answer resolves to; null is no verdict, which reads as ready. A choice to ask the reporter is undone by the ticket
 * changing while the person waited (`reporterFollow(...).changed`): the stop comes back, flagged `changed`.
 */
export function readinessOf(ws: Workstream, runs: readonly Run[], readiness: (run: Run) => { ready: boolean; questions: string[] } | null, replies: readonly string[], events: readonly WorkstreamEvent[]): ReadinessStop | null {
  if (ws.closedAt !== null) return null;
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

/** Pauses `ws` for `reason` as `pause` in src-tauri/src/inbox/workstreams.rs does: not a closed one, and whichever pause came first stays. Null when nothing changes. */
function paused(ws: Workstream, reason: PauseReason): Workstream | null {
  if (ws.closedAt !== null || ws.pausedReason !== null) return null;
  return { ...ws, pausedReason: reason };
}

/** A stored reason this version doesn't know reads as the person's, as `PauseReason`'s `From<String>` does. */
const pauseReasonOf = (reason: unknown): PauseReason | null => (reason == null ? null : reason === "ceiling" ? "ceiling" : "person");

/** A stored workstream from before the fields now left out: they are dropped, and any old hold reads as paused by the person. */
const withDefaults = (w: Workstream & { heldReason?: unknown }): Workstream => {
  const { heldReason, mode: _mode, budget: _budget, spent: _spent, rules: _rules, drifted: _drifted, resumeMode: _resumeMode, ...rest } = w as Workstream & Record<string, unknown>;
  return { ...(rest as Workstream), pausedReason: pauseReasonOf(w.pausedReason ?? heldReason), basis: w.basis ?? null };
};

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
 * backend does.
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
  /** The comment on a ticket written at `at` (one of `repliesTo`'s times) as the view's `reporterReply`; set by the backend that owns the tickets. */
  replyAt: (key: string, at: string) => ReporterReply | null = () => null;
  /** The comments on a ticket from anyone but the signed-in person, with their ids, times and plain text; set by the backend that owns the tickets. */
  replyCommentsOf: (key: string) => { id: string; at: string; text: string }[] = () => [];
  /** The reporter's replies on `ws`'s ticket (`repliesTo`); none for a workstream without one. */
  repliesOf(ws: Pick<Workstream, "itemKey" | "closedAt">): string[] {
    return ws.itemKey && ws.closedAt === null ? this.repliesTo(ws.itemKey) : [];
  }
  /** The pending drafts there are, which Bring them here counts; set by the backend that owns the drafts. */
  pendingDrafts: () => readonly Proposal[] = () => [];
  /** Puts run `id` in workstream `workstream`, or back in General with null; set by the backend that owns the runs. */
  moveRun: (id: string, workstream: string | null) => void = () => {};
  /** The same for draft `id`; set by the backend that owns the drafts. */
  moveDraft: (id: string, workstream: string | null) => void = () => {};
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
  ) {
    const stored = readStored(key) as Partial<Stored> | null;
    this.all = Array.isArray(stored?.workstreams) ? stored.workstreams.filter(isWorkstream).map(withDefaults) : [];
    this.audit = Array.isArray(stored?.events) ? stored.events.filter(isEvent) : [];
    this.seq = Math.max(0, ...this.all.map((w) => Number(/^ws-(\d+)$/.exec(w.id)?.[1] ?? 0)));
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
    const view: WorkstreamView = { workstream: ws, stage: stage(judged), runs: linked.map((r) => r.id), labels: runLabels(linked) };
    const waiting = waitingForPr(linked, this.prOf);
    // The audit is read only for an open workstream, as `view_events` does.
    const events = ws.closedAt === null ? this.audit.filter((e) => e.workstreamId === ws.id) : [];
    const replies = this.repliesOf(ws);
    const readiness = events.length ? readinessOf(ws, linked, (r) => (r.spec.kind === "triage" && r.state === "done" ? this.readinessOfRun(r) : null), replies, events) : null;
    const ticket = ws.closedAt === null && ws.itemKey ? this.ticketOf(ws.itemKey) : null;
    const clarity = ticket ? clarityOf(ws, linked, runs, clarityGaps(docText(ticket.body)), replies, events) : null;
    const { follow, repliedAt } = ws.closedAt === null ? followWithReply(events, replies) : { follow: null, repliedAt: null };
    const waitingOnReporter: ReporterWait | null = follow?.waiting ? { since: follow.waiting } : null;
    const reporterReplied = !!follow?.replied;
    const reporterReply = reporterReplied && repliedAt && ws.itemKey ? this.replyAt(ws.itemKey, repliedAt) : null;
    const reporterReplies = ws.closedAt === null && ws.itemKey ? reporterRepliesOf(events, this.replyCommentsOf(ws.itemKey)) : [];
    const adoptable = ws.closedAt === null && ws.itemKey ? adoptableOf(ws, runs.filter((r) => r.item?.key === ws.itemKey), this.pendingDrafts()) : null;
    return { ...view, ...(adoptable && (adoptable.runs.length || adoptable.drafts.length) ? { adoptable } : {}), ...(waiting ? { waitingForPr: waiting } : {}), ...(reviewBlocking(judged) ? { reviewBlocking: true } : {}), ...(readiness ? { readiness } : {}), ...(clarity ? { clarity } : {}), ...(waitingOnReporter ? { waitingOnReporter } : {}), ...(reporterReplied ? { reporterReplied } : {}), ...(reporterReplied && repliedAt ? { reporterRepliedAt: repliedAt } : {}), ...(reporterReply ? { reporterReply } : {}), ...(reporterReplies.length ? { reporterReplies } : {}) };
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
      pausedReason: null,
      notes: null,
      createdAt: at,
      closedAt: null,
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

  /** Reopens a closed workstream as it stood, as `reopen_workstream`: refused when its ticket has another open one by now; an open one is returned as it is. */
  reopen(id: string): Workstream {
    const ws = this.owned(id);
    if (ws.closedAt === null) return ws;
    if (ws.itemKey && this.forItem(ws.itemKey)) throw new Error(`${ws.itemKey} has another workstream open, so this one can't be reopened`);
    const { closedAt: _, ...rest } = ws;
    return this.changedTo({ ...rest, closedAt: null }, "person", "reopened");
  }

  /**
   * The person's "Bring them here", as `adopt_into_workstream`: the runs and pending drafts on the ticket that are in no
   * workstream become this one's, with one `adopted` line by the person. Returns what moved; refused when there is nothing.
   */
  adopt(id: string): Adoptable {
    const ws = this.openOne(id);
    if (!ws.itemKey) throw new Error("a workstream with no ticket has nothing to bring in");
    const found = adoptableOf(ws, this.runs().filter((r) => r.item?.key === ws.itemKey), this.pendingDrafts());
    if (!found.runs.length && !found.drafts.length) throw new Error(NOTHING_TO_ADOPT);
    found.runs.forEach((r) => this.moveRun(r, ws.id));
    found.drafts.forEach((d) => this.moveDraft(d, ws.id));
    this.record(id, "person", "adopted", { detail: adoptWords(found) });
    return found;
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
   * `readiness_overridden`, which settles the stop. Refused with `READINESS_GONE` unless the stop is about `triage`.
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

  /**
   * The workstream `id` that waits on the reporter, for a nudge to them, as `nudge_reporter` checks it: refused with
   * `NUDGE_GONE` unless it waits, has for `NUDGE_AFTER_DAYS` days or more, and no nudge waits among `pending` (its drafts).
   */
  nudgeDue(id: string, pending: readonly Proposal[], now: Date): string {
    const view = this.get(id);
    const key = view?.workstream.itemKey;
    if (!view || !key || !nudgeOffered(view.waitingOnReporter, now, pending, id)) throw new Error(NUDGE_GONE);
    return key;
  }

  /** Records `reporter_nudged` (the person's, naming the draft they asked for), as `nudge_reporter` does after drafting. */
  nudged(id: string, proposalId: string) {
    this.record(id, "person", "reporter_nudged", { proposalId });
  }

  /** Audits the page's clarity learning, as `note_clarity`: only `clarity_learned` and `clarity_reset` are taken. */
  noteClarity(id: string, action: string, detail: string) {
    if (!CLARITY_NOTES.includes(action)) throw new Error(`"${action}" isn't a note about the clarity check`);
    this.owned(id);
    this.record(id, "person", action, { detail: detail.replace(/[\u0000-\u001f]/g, "").slice(0, 120) });
  }

  /** Records `readiness_asked` (the person's, naming the Triage and the draft they asked for), as `ask_reporter` does after drafting. */
  askedReporter(id: string, triage: string, proposalId: string) {
    this.record(id, "person", "readiness_asked", { runId: triage, proposalId });
  }

  /** Pauses an open workstream, as `pause_workstream` does: one already paused keeps its reason. */
  pause(id: string, reason: PauseReason = "person", actor: WorkstreamActor = "person"): Workstream {
    const ws = this.openOne(id);
    const next = paused(ws, reason);
    return next ? this.changedTo(next, actor, "paused", { detail: reason }) : ws;
  }

  /** Resumes a workstream, whatever paused it, as `resume_workstream` does. One that isn't paused records nothing. */
  resume(id: string): Workstream {
    const ws = this.openOne(id);
    if (ws.pausedReason === null) return ws;
    return this.changedTo({ ...ws, pausedReason: null }, "person", "resumed", { detail: ws.pausedReason });
  }

  /**
   * The person's Undo of "Bring them here", as `undo_workstream` does: only while that change is the last line of the audit,
   * the person's, and under `UNDO_WINDOW_MS` old. It adds an `undone` line naming what it took back; the line it follows stays.
   */
  undo(id: string, undo: WorkstreamUndo): Workstream {
    const ws = this.openOne(id);
    const events = this.events(id);
    const last = events[events.length - 1];
    const gone = () => new Error("That change can't be undone any more: something else happened since, or it was a while ago.");
    const fresh = !!last && last.actor === "person" && this.now().getTime() - Date.parse(last.at) <= UNDO_WINDOW_MS;
    if (!fresh || last!.action !== "adopted") throw gone();
    const mine = new Set(this.runs().filter((r) => r.spec.workstream === id).map((r) => r.id));
    const pending = new Map(this.pendingDrafts().map((p) => [p.id, p] as const));
    undo.runs.filter((r) => mine.has(r)).forEach((r) => this.moveRun(r, null));
    undo.drafts.filter((d) => pending.has(d) && workstreamOf(pending.get(d)!) === id).forEach((d) => this.moveDraft(d, null));
    return this.changedTo(ws, "person", "undone", { detail: "adopted" });
  }

  /**
   * Notices workstream `id`'s ticket drifting from its basis, as `note_basis_drift`: the fields that drifted are recorded once in
   * a supervisor `basis_drifted` line and the basis is taken again from the ticket as it is now (`basis_captured`). Nothing
   * pauses. A workstream with no basis yet has it captured and hasn't drifted. Whether it drifted; false with nothing to
   * compare (no ticket, or not cached).
   */
  noteBasisDrift(id: string): boolean {
    const ws = this.owned(id);
    const ticket = ws.itemKey ? this.ticketOf(ws.itemKey) : null;
    if (!ticket) return false;
    const fields = ws.basis ? driftOf(ws.basis, ticket) : [];
    if (ws.basis && !fields.length) return false;
    this.put({ ...ws, basis: basisOfItem(ticket) });
    if (fields.length) this.append(id, "supervisor", "basis_drifted", { detail: fields.join(",") });
    this.append(id, "supervisor", "basis_captured");
    this.save();
    this.changed();
    return fields.length > 0;
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

  /**
   * Lets the facts `woken` (run and state key) wake Pip in workstream `id`, as `admit_wake` does: each gets a supervisor
   * `wake` line. Once the workstream has had `WAKES_PER_WORKSTREAM_PER_DAY` wake turns since midnight or the person's
   * last resume, or Pip `WAKE_TURNS_PER_DAY` across workstreams since midnight, nothing wakes: the workstream is paused for
   * `ceiling` with a supervisor `paused` line. A turn is the wake lines recorded at one moment. True when Pip is to be woken.
   */
  admitWake(id: string, woken: { run: string; key: string }[]): boolean {
    const ws = this.all.find((w) => w.id === id && w.closedAt === null);
    if (!ws || ws.pausedReason !== null || !woken.length) return false;
    const now = this.now();
    const midnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
    const turns = (events: readonly WorkstreamEvent[], since: string) => new Set(events.filter((e) => e.actor === "supervisor" && e.action === "wake" && e.at >= since).map((e) => `${e.workstreamId}@${e.at}`)).size;
    const resumed = this.events(id).filter((e) => e.actor === "person" && e.action === "resumed").map((e) => e.at).sort().pop();
    const own = turns(this.audit.filter((e) => e.workstreamId === id), resumed && resumed > midnight ? resumed : midnight);
    if (own >= WAKES_PER_WORKSTREAM_PER_DAY || turns(this.audit, midnight) >= WAKE_TURNS_PER_DAY) {
      this.put({ ...ws, pausedReason: "ceiling" });
      this.append(id, "supervisor", "paused", { detail: "ceiling" });
      this.save();
      this.changed();
      return false;
    }
    for (const f of woken) this.append(id, "supervisor", "wake", { runId: f.run, detail: f.key });
    this.save();
    this.changed();
    return true;
  }

  /** Whether someone but the person has commented on ticket `key` since the reporter was asked on an open workstream of it: what a Triage run then reads from the comments. */
  reporterRepliedOn(key: string): boolean {
    return this.all.some((ws) => ws.itemKey === key && ws.closedAt === null && reporterRepliesOf(this.audit.filter((e) => e.workstreamId === ws.id), this.replyCommentsOf(key)).length > 0);
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
