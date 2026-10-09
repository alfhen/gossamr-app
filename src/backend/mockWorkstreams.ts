import { byQueue, runLabels, stage } from "../lib/workstreamStage";
import { readStored, writeStored } from "../workspace/storage";
import type { ItemRef, Run, Workstream, WorkstreamActor, WorkstreamEvent, WorkstreamView, WorkstreamsChanged } from "../types";

const CONNECTION = "mock";
/** Where the sample backend keeps its workstreams and their audit, so both survive a reload. */
export const MOCK_WORKSTREAMS_KEY = "gossamr-mock-workstreams";
/** Pip's notes are kept up to this many bytes, after scrubbing (NOTES_LIMIT in src-tauri/src/inbox/workstreams.rs). */
export const NOTES_LIMIT = 2_048;
const TITLE_LIMIT = 200;
/** What a workstream id may be, as `RunSpec::validate` checks it. */
const ID_LIMIT = 64;
/** The markers prompts and Pip's context fence data with; notes holding any of them are refused rather than cleaned. */
const MARKERS = ["<<<TICKET", "TICKET>>>", "<<<FOCUS", "FOCUS>>>", "<<<PLAN", "PLAN>>>", "<<<BUILD", "BUILD>>>", "<<<FINDINGS", "FINDINGS>>>", "<<<AGENT_OUTPUT", "AGENT_OUTPUT>>>", "<<<PIP_NOTES", "PIP_NOTES>>>"];

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
function textDigest(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return `mock-${h.toString(16).padStart(8, "0")}`;
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

/** Why `id` can't be a workstream id at all, as `RunSpec::validate` refuses it; null when it can. */
export function workstreamIdProblem(id: string): string | null {
  if (!id || [...id].length > ID_LIMIT || /[\u0000-\u001f\u007f]/.test(id)) return "the workstream id must be 1 to 64 characters with no control characters";
  return null;
}

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
 * backend does. Nothing here starts, stops or answers a run or writes to Jira.
 */
export class MockWorkstreams {
  private all: Workstream[] = [];
  private audit: WorkstreamEvent[] = [];
  private listeners = new Set<(c: WorkstreamsChanged) => void>();
  private seq = 0;
  /** The number of the pull request run `runId` opened, as far as the code host shows it; set by the backend that owns the code. */
  prOf: (runId: string) => number | null = () => null;

  /**
   * `runs` lists the runs there are, `titleOf` the title of a cached ticket (null when it isn't cached). `now` is the
   * clock, fixed in tests.
   */
  constructor(
    private readonly runs: () => readonly Run[],
    private readonly titleOf: (item: ItemRef) => string | null,
    private readonly now: () => Date = () => new Date(),
    private readonly key: string = MOCK_WORKSTREAMS_KEY,
  ) {
    const stored = readStored(key) as Partial<Stored> | null;
    this.all = Array.isArray(stored?.workstreams) ? stored.workstreams.filter(isWorkstream) : [];
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
    const view: WorkstreamView = { workstream: ws, stage: stage(linked), runs: linked.map((r) => r.id), labels: runLabels(linked) };
    const waiting = waitingForPr(linked, this.prOf);
    return waiting ? { ...view, waitingForPr: waiting } : view;
  }

  /** Opens a workstream on a cached ticket, or with no ticket and a title. A ticket with an open one gets that one back, unchanged. */
  open(item: ItemRef | null, title: string | null = null): Workstream {
    if (item && item.connectionId !== CONNECTION) throw new Error("that item belongs to another connection");
    const named = title === null ? "" : flat(title);
    let itemKey: string | null = null;
    let made: string;
    if (item) {
      const open = this.forItem(item.key);
      if (open) return open;
      const work = this.titleOf(item);
      if (work === null) throw new Error(`${item.key} isn't in the cache, so there is nothing to base a workstream on`);
      itemKey = item.key;
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
      mode: "advise",
      heldReason: null,
      notes: null,
      createdAt: at,
      closedAt: null,
      budget: { autoTurns: null, wakes: null, tokens: null },
      spent: { autoTurns: 0, wakes: 0, tokens: 0 },
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
