import { budgetLevel, budgetView } from "../lib/workstreamHold";
import { byQueue, runLabels, stage } from "../lib/workstreamStage";
import { readStored, writeStored } from "../workspace/storage";
import { HELD_ALL, HELD_BUDGET, HELD_DAILY, HELD_PERSON, HELD_QUOTA, HELD_RESTART, TRIPWIRE, TRIPWIRES, WORKSTREAM_RULES } from "../types";
import type { ItemRef, Run, Workstream, WorkstreamActor, WorkstreamBasis, WorkstreamBudget, WorkstreamEvent, WorkstreamMode, WorkstreamRule, WorkstreamView, WorkstreamsChanged } from "../types";
import { startedFresh } from "./mockPipTurns";

const CONNECTION = "mock";
/** Where the sample backend keeps its workstreams and their audit, so both survive a reload. */
export const MOCK_WORKSTREAMS_KEY = "gossamr-mock-workstreams";
/** Pip's notes are kept up to this many bytes, after scrubbing (NOTES_LIMIT in src-tauri/src/inbox/workstreams.rs). */
export const NOTES_LIMIT = 2_048;
const TITLE_LIMIT = 200;
/** What a workstream id may be, as `RunSpec::validate` checks it. */
const ID_LIMIT = 64;
/** The markers prompts and Pip's context fence data with; notes holding any of them are refused rather than cleaned. */
export const MARKERS = ["<<<TICKET", "TICKET>>>", "<<<FOCUS", "FOCUS>>>", "<<<PLAN", "PLAN>>>", "<<<BUILD", "BUILD>>>", "<<<FINDINGS", "FINDINGS>>>", "<<<AGENT_OUTPUT", "AGENT_OUTPUT>>>", "<<<PIP_NOTES", "PIP_NOTES>>>"];

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
  if (ws.heldReason !== null && !(reason === HELD_PERSON && [HELD_RESTART, HELD_BUDGET, HELD_QUOTA].includes(ws.heldReason))) return null;
  return { ...ws, heldReason: reason };
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
  /** What a cached ticket looks like now, kept as a new workstream's basis; set by the backend that owns the tickets. */
  basisOf: (item: ItemRef) => WorkstreamBasis | null = () => null;

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
    const view: WorkstreamView = { workstream: ws, stage: stage(linked), runs: linked.map((r) => r.id), labels: runLabels(linked), budget: budgetView(ws) };
    const waiting = waitingForPr(linked, this.prOf);
    return waiting ? { ...view, waitingForPr: waiting } : view;
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
      basis = this.basisOf(item);
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

  /** Sets how much Pip may do on its own, as `set_workstream_mode` does; the same mode records nothing. */
  setMode(id: string, mode: WorkstreamMode, actor: WorkstreamActor = "person"): Workstream {
    const ws = this.openOne(id);
    if (ws.mode === mode) return ws;
    return this.changedTo({ ...ws, mode }, actor, "mode_set", { detail: mode });
  }

  /** Holds an open workstream, as `hold_workstream` does: an existing reason is kept unless the person's hold replaces a restart, budget or quota one. */
  hold(id: string, reason: string = HELD_PERSON, actor: WorkstreamActor = "person"): Workstream {
    if (!validHoldReason(reason)) throw new Error(`"${reason}" isn't a reason to hold a workstream`);
    const ws = this.openOne(id);
    const next = held(ws, reason);
    return next ? this.changedTo(next, actor, "held", { detail: reason }) : ws;
  }

  /** Lifts a workstream's hold, as `resume_workstream` does; lifting a budget hold also resets what was spent (`budget_reset`). */
  resume(id: string): Workstream {
    const ws = this.openOne(id);
    if (ws.heldReason === null) return ws;
    const reset = ws.heldReason === HELD_BUDGET;
    const next: Workstream = { ...ws, heldReason: null, spent: reset ? { ...ws.spent, autoTurns: 0, wakes: 0 } : ws.spent };
    this.changedTo(next, "person", "resumed", { detail: ws.heldReason });
    if (reset) this.record(id, "person", "budget_reset");
    return next;
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
   * Advise and is held with `tripwire:<kind>`.
   */
  trip(id: string, kind: string, runId: string | null): Workstream {
    const reason = `${TRIPWIRE}${kind}`;
    if (!validHoldReason(reason)) throw new Error(`there is no tripwire "${kind}"`);
    let ws = this.openOne(id);
    this.append(id, "supervisor", "tripwire", { runId, detail: kind });
    if (ws.mode !== "advise") {
      ws = { ...ws, mode: "advise" };
      this.append(id, "supervisor", "mode_set", { detail: "advise" });
    }
    const next = held(ws, reason);
    if (next) {
      ws = next;
      this.append(id, "supervisor", "held", { detail: reason });
    }
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
