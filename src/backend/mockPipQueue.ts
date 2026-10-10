import type { AskOutcome, AskRequest } from "./claude";
import type { ScreenContext } from "../types";
import { metaOf, mockAsk, mockCancel, mockPipEvents, type PipDrafter } from "./mockPip";
import { REMOVED, mockPipTurns } from "./mockPipTurns";
import { eventLine, type WakeFact } from "./mockSupervisor";
import { GENERAL_CONVERSATION, conversationId, workstreamConversation, workstreamOfConversation } from "../lib/conversations";

/** How many of Pip's turns may run at once across every conversation (PIP_PROCESSES in src-tauri/src/agent/queue.rs). */
export const PIP_PROCESSES = 2;

export type Enqueued<T> = { start: true; item: T } | { start: false; ahead: number };
export type Removed<T> = { type: "waiting"; item: T } | { type: "inFlight" } | { type: "unknown" };

interface Entry<T> {
  id: string;
  order: number;
  item: T;
}

interface Lane<T> {
  inFlight: string | null;
  waiting: Entry<T>[];
}

/**
 * The sample backend's copy of the app's turn queue (src-tauri/src/agent/queue.rs): each conversation answers one turn at
 * a time in the order sent, and no more than `cap` run at once. `preempted` says whether an item gives way to a person's
 * message, which then goes ahead of it while it waits: a wake does. Both run the cases in
 * src-tauri/test-support/pip-queue-cases.json.
 */
export function createTurnQueue<T>(cap = PIP_PROCESSES, preempted: (item: T) => boolean = () => false) {
  const lanes = new Map<string, Lane<T>>();
  const owner = new Map<string, string>();
  const sessions = new Map<string, string>();
  let next = 0;

  const running = () => [...lanes.values()].filter((l) => l.inFlight !== null).length;
  const tidy = () => {
    for (const [c, l] of lanes) if (l.inFlight === null && !l.waiting.length) lanes.delete(c);
  };

  return {
    enqueue(conversation: string, requestId: string, item: T): Enqueued<T> {
      const room = running() < Math.max(cap, 1);
      const lane = lanes.get(conversation) ?? { inFlight: null, waiting: [] };
      lanes.set(conversation, lane);
      owner.set(requestId, conversation);
      if (room && lane.inFlight === null && !lane.waiting.length) {
        lane.inFlight = requestId;
        return { start: true, item };
      }
      const yields = lane.waiting.findIndex((e) => preempted(e.item));
      const at = preempted(item) || yields < 0 ? lane.waiting.length : yields;
      lane.waiting.splice(at, 0, { id: requestId, order: ++next, item });
      return { start: false, ahead: at + (lane.inFlight !== null ? 1 : 0) };
    },

    /** Ends the running turn `requestId` and returns what may start now: a person's before a wake, then oldest first. Anything but a running turn is ignored. */
    finished(requestId: string, session: string | null): [string, T][] {
      const conversation = owner.get(requestId);
      const lane = conversation === undefined ? undefined : lanes.get(conversation);
      if (conversation === undefined || !lane || lane.inFlight !== requestId) return [];
      lane.inFlight = null;
      owner.delete(requestId);
      if (session) sessions.set(conversation, session);
      const started: [string, T][] = [];
      while (running() < Math.max(cap, 1)) {
        // A person's turn waiting anywhere goes before a wake, however long the wake has waited.
        let pick: [number, number, Lane<T>] | null = null;
        for (const l of lanes.values()) {
          const head = l.waiting[0];
          if (l.inFlight !== null || !head) continue;
          const rank = preempted(head.item) ? 1 : 0;
          if (!pick || rank < pick[0] || (rank === pick[0] && head.order < pick[1])) pick = [rank, head.order, l];
        }
        if (!pick) break;
        const entry = pick[2].waiting.shift()!;
        pick[2].inFlight = entry.id;
        started.push([entry.id, entry.item]);
      }
      tidy();
      return started;
    },

    /** Takes a waiting turn out of the queue. A running one stays where it is. */
    remove(requestId: string): Removed<T> {
      const conversation = owner.get(requestId);
      const lane = conversation === undefined ? undefined : lanes.get(conversation);
      if (!lane) return { type: "unknown" };
      if (lane.inFlight === requestId) return { type: "inFlight" };
      const at = lane.waiting.findIndex((e) => e.id === requestId);
      if (at < 0) return { type: "unknown" };
      const [entry] = lane.waiting.splice(at, 1);
      owner.delete(requestId);
      tidy();
      return { type: "waiting", item: entry.item };
    },

    /** How many turns of its conversation are ahead of `requestId`: 0 for the running one, null when it is neither waiting nor running. */
    position(requestId: string): number | null {
      const conversation = owner.get(requestId);
      const lane = conversation === undefined ? undefined : lanes.get(conversation);
      if (!lane) return null;
      if (lane.inFlight === requestId) return 0;
      const at = lane.waiting.findIndex((e) => e.id === requestId);
      return at < 0 ? null : at + (lane.inFlight !== null ? 1 : 0);
    },

    /** The items waiting in `conversation`, in the order they will run, with their request ids. */
    waitingIn(conversation: string): [string, T][] {
      return (lanes.get(conversation)?.waiting ?? []).map((e) => [e.id, e.item]);
    },

    /** The turn `conversation` is answering, if any. */
    inFlightIn(conversation: string): string | null {
      return lanes.get(conversation)?.inFlight ?? null;
    },

    /** The conversations with a turn running or waiting. */
    conversations(): string[] {
      return [...lanes.keys()];
    },

    /** The session `conversation`'s last finished turn ended with. */
    session(conversation: string): string | null {
      return sessions.get(conversation) ?? null;
    },

    running,
  };
}

interface Waiting {
  req: AskRequest;
  drafter: Partial<PipDrafter> | null;
  pace: number | undefined;
  /** For a wake: what it is about, merged with any wakes that came while it waited. */
  wake?: { workstream: string; facts: WakeFact[] };
}

const givesWay = (w: Waiting) => !!w.wake;
let queue = createTurnQueue<Waiting>(PIP_PROCESSES, givesWay);
/** The wakes being answered, by request id, so a person's message can set one aside and queue its facts again. */
let wakesRunning = new Map<string, { workstream: string; facts: WakeFact[] }>();
let wakeSeq = 0;

/** Starts over with an empty queue, for tests. */
export function resetMockPipQueue() {
  queue = createTurnQueue<Waiting>(PIP_PROCESSES, givesWay);
  wakesRunning = new Map();
}

/** The screen a wake is answered with: nothing on it, as nobody asked. */
const NO_SCREEN: ScreenContext = { view: null, item: null, filter: null, selection: [] };

/** The same fact twice, as `WakeFacts::merge` tells them apart: the run and what it did. */
const sameFact = (a: WakeFact, b: WakeFact) => a.run === b.run && a.state === b.state;

const conversationOf = (req: AskRequest) => conversationId(req.conversation ?? GENERAL_CONVERSATION);

function start({ req, drafter, pace, wake }: Waiting) {
  mockPipTurns.setStatus(req.requestId, "running");
  mockPipEvents.emit(req.requestId, { type: "running" }, metaOf(req));
  if (wake) wakesRunning.set(req.requestId, wake);
  mockAsk(req, drafter, pace).then(
    (session) => release(req.requestId, session),
    (err) => {
      mockPipEvents.emit(req.requestId, { type: "done", sessionId: null, ok: false, message: String(err) }, metaOf(req));
      release(req.requestId, null);
    },
  );
}

/** Ends `requestId`'s place in the queue and starts what may run now. A turn sent without a session continues its conversation's. */
function release(requestId: string, session: string | null) {
  wakesRunning.delete(requestId);
  for (const [, waiting] of queue.finished(requestId, session)) {
    const sessionId = waiting.req.sessionId ?? queue.session(conversationOf(waiting.req));
    start({ ...waiting, req: { ...waiting.req, sessionId } });
  }
}

/** Puts `item` in its conversation's queue and starts it or says it waits. */
function enter(conversation: string, item: Waiting): AskOutcome {
  const entered = queue.enqueue(conversation, item.req.requestId, item);
  if (entered.start) {
    start(entered.item);
    return { queued: false, ahead: 0 };
  }
  mockPipEvents.emit(item.req.requestId, { type: "queued", ahead: entered.ahead }, metaOf(item.req));
  return { queued: true, ahead: entered.ahead };
}

/**
 * Queues a question for the scripted Pip, as `ask_claude` does, and says whether it started or waits. In a workstream's
 * conversation the person goes first, as `AgentService::ask` has it: a waiting wake is taken out, a running one is
 * stopped and its facts are queued again behind the message, and their message counts the automatic turns from zero.
 */
export function mockQueueAsk(req: AskRequest, drafter: Partial<PipDrafter> | null, pace?: number): AskOutcome {
  if (queue.position(req.requestId) !== null) throw new Error("That question was already sent.");
  const conversation = conversationOf(req);
  const workstream = req.kind === "wake" ? null : workstreamOfConversation(conversation);
  let again: { workstream: string; facts: WakeFact[] } | undefined;
  if (workstream) {
    for (const [id, w] of queue.waitingIn(conversation)) if (w.wake) mockQueueCancel(id);
    const running = queue.inFlightIn(conversation);
    again = running ? wakesRunning.get(running) : undefined;
    if (running && again) {
      wakesRunning.delete(running);
      mockCancel(running);
    }
  }
  mockPipTurns.begin(conversation, req.requestId, req.prompt, req.meta ?? { imageCount: req.images?.length ?? 0 }, "queued", new Date(), { context: req.context, sessionId: req.sessionId });
  const outcome = enter(conversation, { req, drafter, pace });
  if (workstream) {
    if (again) mockQueueWake(again.workstream, again.facts, drafter, pace);
    drafter?.pipPersonWrote?.(workstream);
  }
  return outcome;
}

/**
 * Wakes the scripted Pip in workstream `workstream`'s conversation about `facts`, as `AgentService::wake` does: the turn
 * is kept as a wake with the event lines as its prompt, and merged into a wake already waiting there rather than
 * queued as a second. Returns the wake's request id.
 */
export function mockQueueWake(workstream: string, facts: WakeFact[], drafter: Partial<PipDrafter> | null, pace?: number): string {
  const conversation = workstreamConversation(workstream);
  const waiting = queue.waitingIn(conversation).find(([, w]) => w.wake);
  if (waiting) {
    const [id, w] = waiting;
    const merged = [...w.wake!.facts, ...facts.filter((f) => !w.wake!.facts.some((g) => sameFact(f, g)))];
    w.wake = { workstream, facts: merged };
    w.req = { ...w.req, prompt: eventLine(merged) };
    mockPipTurns.setPrompt(id, w.req.prompt);
    mockPipEvents.emit(id, { type: "queued", ahead: queue.position(id) ?? 0 }, metaOf(w.req));
    return id;
  }
  const req: AskRequest = { requestId: `wake-${Date.now().toString(36)}-${++wakeSeq}`, prompt: eventLine(facts), context: NO_SCREEN, sessionId: null, conversation, kind: "wake" };
  mockPipTurns.begin(conversation, req.requestId, req.prompt, { imageCount: 0 }, "queued", new Date(), undefined, "wake");
  enter(conversation, { req, drafter, pace, wake: { workstream, facts } });
  return req.requestId;
}

/** Whether the scripted Pip has nothing to do: no turn running or waiting in any conversation, a wake's included. */
export function mockPipIdle(): boolean {
  return queue.conversations().length === 0;
}

/** Whether a wake waits in `conversation`, which a new one merges into without spending the budget. */
export function mockHasWaitingWake(conversation: string): boolean {
  return queue.waitingIn(conversationId(conversation)).some(([, w]) => !!w.wake);
}

/** Stops every turn of the conversations `which` picks, waiting ones first, as holding or closing a workstream does. */
export function mockCancelTurns(which: (conversation: string) => boolean) {
  for (const conversation of queue.conversations().filter(which)) {
    for (const [id] of queue.waitingIn(conversation)) mockQueueCancel(id);
    const running = queue.inFlightIn(conversation);
    if (running) {
      wakesRunning.delete(running);
      mockCancel(running);
    }
  }
}

/** Stops the wakes of workstream `workstream`, waiting or running, and leaves the person's turns be, as `cancel_workstream_wakes` does when a tripwire fires. */
export function mockCancelWakes(workstream: string) {
  const conversation = `ws:${workstream}`;
  for (const [id, w] of queue.waitingIn(conversation)) if (w.wake) mockQueueCancel(id);
  const running = queue.inFlightIn(conversation);
  if (running && wakesRunning.has(running)) {
    wakesRunning.delete(running);
    mockCancel(running);
  }
}

/** Stops a turn as `cancel_claude` does: one still waiting never starts and ends failed; the running one is stopped. */
export function mockQueueCancel(requestId: string) {
  const waiting = queue.conversations().flatMap((c) => queue.waitingIn(c)).find(([id]) => id === requestId)?.[1];
  const removed = queue.remove(requestId);
  if (removed.type === "waiting") {
    mockPipTurns.finish(requestId, { ok: false, error: REMOVED, sessionId: null, usage: null });
    mockPipEvents.emit(requestId, { type: "done", sessionId: null, ok: false, message: REMOVED }, waiting ? metaOf(waiting.req) : undefined);
  } else if (removed.type === "inFlight") {
    mockCancel(requestId);
  }
}

/** The drafting a resumed turn does again, minus any draft its first run already made: those outlived the reload. */
function drafterFor(requestId: string, drafter: Partial<PipDrafter> | null): Partial<PipDrafter> | null {
  if (!drafter?.pipDrafted?.(requestId)) return drafter;
  const { pipDraft: _d, pipRewrite: _r, pipFollowUp: _f, pipRunDraft: _g, pipTicketlessRunDraft: _t, ...rest } = drafter;
  return rest;
}

/**
 * Asks again, oldest first, the turns a reload cut off, as the app's queue carries them on across one. Each starts its
 * scripted answer over; done once per page, before anything else is asked.
 */
export function mockResume(drafter: Partial<PipDrafter> | null, pace?: number) {
  for (const t of mockPipTurns.resume()) {
    mockQueueAsk({ requestId: t.requestId, prompt: t.prompt, context: t.ask.context, sessionId: t.ask.sessionId, conversation: t.conversation, meta: t.meta }, drafterFor(t.requestId, drafter), pace);
  }
}
