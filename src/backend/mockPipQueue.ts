import type { AskOutcome, AskRequest } from "./claude";
import { mockAsk, mockCancel, mockPipEvents, type PipDrafter } from "./mockPip";
import { REMOVED, mockPipTurns } from "./mockPipTurns";

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
 * a time in the order sent, and no more than `cap` run at once. `preempted` says whether a person's message goes ahead
 * of a waiting item; nothing gives way yet, as in the app. Both run the cases in src-tauri/test-support/pip-queue-cases.json.
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

    /** Ends the running turn `requestId` and returns what may start now, oldest first. Anything but a running turn is ignored. */
    finished(requestId: string, session: string | null): [string, T][] {
      const conversation = owner.get(requestId);
      const lane = conversation === undefined ? undefined : lanes.get(conversation);
      if (conversation === undefined || !lane || lane.inFlight !== requestId) return [];
      lane.inFlight = null;
      owner.delete(requestId);
      if (session) sessions.set(conversation, session);
      const started: [string, T][] = [];
      while (running() < Math.max(cap, 1)) {
        let pick: [number, Lane<T>] | null = null;
        for (const l of lanes.values()) {
          const head = l.waiting[0];
          if (l.inFlight === null && head && (!pick || head.order < pick[0])) pick = [head.order, l];
        }
        if (!pick) break;
        const entry = pick[1].waiting.shift()!;
        pick[1].inFlight = entry.id;
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
}

let queue = createTurnQueue<Waiting>();

/** Starts over with an empty queue, for tests. */
export function resetMockPipQueue() {
  queue = createTurnQueue<Waiting>();
}

const conversationOf = (req: AskRequest) => req.conversation ?? "workspace";

function start({ req, drafter, pace }: Waiting) {
  mockPipTurns.setStatus(req.requestId, "running");
  mockPipEvents.emit(req.requestId, { type: "running" });
  mockAsk(req, drafter, pace).then(
    (session) => release(req.requestId, session),
    (err) => {
      mockPipEvents.emit(req.requestId, { type: "done", sessionId: null, ok: false, message: String(err) });
      release(req.requestId, null);
    },
  );
}

/** Ends `requestId`'s place in the queue and starts what may run now. A turn sent without a session continues its conversation's. */
function release(requestId: string, session: string | null) {
  for (const [, waiting] of queue.finished(requestId, session)) {
    const sessionId = waiting.req.sessionId ?? queue.session(conversationOf(waiting.req));
    start({ ...waiting, req: { ...waiting.req, sessionId } });
  }
}

/** Queues a question for the scripted Pip, as `ask_claude` does, and says whether it started or waits. */
export function mockQueueAsk(req: AskRequest, drafter: Partial<PipDrafter> | null, pace?: number): AskOutcome {
  if (queue.position(req.requestId) !== null) throw new Error("That question was already sent.");
  mockPipTurns.begin(conversationOf(req), req.requestId, req.prompt, req.meta ?? { imageCount: req.images?.length ?? 0 }, "queued", new Date(), { context: req.context, sessionId: req.sessionId });
  const entered = queue.enqueue(conversationOf(req), req.requestId, { req, drafter, pace });
  if (entered.start) {
    start(entered.item);
    return { queued: false, ahead: 0 };
  }
  mockPipEvents.emit(req.requestId, { type: "queued", ahead: entered.ahead });
  return { queued: true, ahead: entered.ahead };
}

/** Stops a turn as `cancel_claude` does: one still waiting never starts and ends failed; the running one is stopped. */
export function mockQueueCancel(requestId: string) {
  const removed = queue.remove(requestId);
  if (removed.type === "waiting") {
    mockPipTurns.finish(requestId, { ok: false, error: REMOVED, sessionId: null, usage: null });
    mockPipEvents.emit(requestId, { type: "done", sessionId: null, ok: false, message: REMOVED });
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
