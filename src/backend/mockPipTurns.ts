import { readStored, writeStored } from "../workspace/storage";
import type { ScreenContext } from "../types";
import type { StoredTurn, TurnMeta, TurnUsage } from "./claude";

const KEY = "gossamr-mock-pip-turns";
/** Set in the tab's session storage once the sample app has opened in it, so a reload can be told from a fresh start. */
const OPEN = "gossamr-mock-pip-open";
/** Turns older than this are forgotten, as a full sync prunes them in the app. */
export const MOCK_TURN_DAYS = 90;
/** Why a turn that was still going when the app last closed is shown as failed, as the app says it after a restart (INTERRUPTED in src-tauri/src/db/pip_turns.rs). */
export const INTERRUPTED = "Gossamr closed before Pip finished";
/** Why a turn that was still waiting its turn when the app last closed is shown as failed (NEVER_RAN in src-tauri/src/db/pip_turns.rs). */
export const NEVER_RAN = "Gossamr closed before this question ran";
/** Why a turn taken out of the queue never ran, as the app says it (REMOVED in src-tauri/src/agent/mod.rs). */
export const REMOVED = "Removed before it started";

const DAY = 24 * 60 * 60 * 1000;

/** What the sample backend needs to ask a question again after a reload; the app's queue keeps this in memory across one. */
export interface Resumable {
  context: ScreenContext;
  sessionId: string | null;
}

/** A stored turn as the sample backend keeps it: with what asking it again takes, while it is still going. */
type MockTurn = StoredTurn & { ask?: Resumable };

/** A turn a reload cut off, to be asked again from the start. */
export interface Resumed {
  requestId: string;
  conversation: string;
  prompt: string;
  meta: TurnMeta;
  ask: Resumable;
}

const isTurn = (t: unknown): t is MockTurn => {
  const x = t as Partial<StoredTurn> | null;
  return !!x && typeof x.requestId === "string" && typeof x.conversation === "string" && typeof x.prompt === "string" && typeof x.createdAt === "string";
};

const going = (t: StoredTurn) => t.status === "queued" || t.status === "running";

/**
 * Whether this page is a fresh start of the app rather than a reload of one already open. A tab's session storage
 * outlives a reload but not the tab, so a new tab or window is a restart, as quitting and opening the app is.
 */
export function freshStart(): boolean {
  try {
    const session = globalThis.sessionStorage;
    if (!session) return true;
    const reload = session.getItem(OPEN) !== null;
    session.setItem(OPEN, "1");
    return !reload;
  } catch {
    return true;
  }
}

/**
 * The sample backend's stand-in for the `pip_turns` table: the scripted Pip's conversations, kept in this browser so one
 * survives a reload. Opening it after a restart does what a restart does in the app: a turn left waiting or running is
 * failed. After a reload the app's turns go on, since reloading the page doesn't stop the app; here they are asked
 * again from the start (`resume`). Turns past the horizon are pruned either way. What a running turn has said so far
 * lives in memory only, as it does in the app.
 */
export function openMockPipTurns(now: number = Date.now(), restart: boolean = freshStart()) {
  let all: MockTurn[] = [];
  const live = new Map<string, { text: string; steps: string[] }>();

  const save = () => writeStored(KEY, all);
  const update = (requestId: string, fn: (t: MockTurn) => MockTurn) => {
    const at = all.findIndex((t) => t.requestId === requestId);
    if (at < 0) return;
    all = all.map((t, i) => (i === at ? fn(t) : t));
    save();
  };

  const stored = readStored(KEY);
  const horizon = new Date(now - MOCK_TURN_DAYS * DAY).toISOString();
  // A turn cut off by a reload starts over, so what it had said is dropped; one that can't be asked again is failed.
  const cutOff = (t: MockTurn): MockTurn =>
    !restart && t.ask ? { ...t, status: "queued", text: "", steps: [] } : { ...t, status: "failed", error: t.status === "queued" ? NEVER_RAN : INTERRUPTED, ask: undefined };
  all = (Array.isArray(stored) ? stored.filter(isTurn) : []).filter((t) => t.createdAt >= horizon).map((t) => (going(t) ? cutOff(t) : t));
  let resumable = all.filter((t) => going(t) && t.ask).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  if (stored !== null) save();

  return {
    /** The turns of `conversation`, oldest first, with what a running one has said so far. */
    turns(conversation: string): StoredTurn[] {
      return all
        .filter((t) => t.conversation === conversation)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .map(({ ask: _, ...t }) => {
          const l = live.get(t.requestId);
          return l && going(t) ? { ...t, text: l.text, steps: [...l.steps] } : { ...t, steps: [...t.steps] };
        });
    },

    /** Whether a turn with this request id is kept. */
    has(requestId: string): boolean {
      return all.some((t) => t.requestId === requestId);
    },

    /** The turns a reload cut off, oldest first, once: the caller asks each again. */
    resume(): Resumed[] {
      const out = resumable.map((t) => ({ requestId: t.requestId, conversation: t.conversation, prompt: t.prompt, meta: { quote: t.quote, looking: t.looking, imageCount: t.imageCount }, ask: t.ask! }));
      resumable = [];
      for (const t of out) live.set(t.requestId, { text: "", steps: [] });
      return out;
    },

    begin(conversation: string, requestId: string, prompt: string, meta: TurnMeta, status: "queued" | "running" = "running", at = new Date(), ask?: Resumable) {
      if (all.some((t) => t.requestId === requestId)) return;
      all = [
        ...all,
        {
          requestId,
          conversation,
          prompt,
          ...(meta.quote ? { quote: meta.quote } : {}),
          ...(meta.looking ? { looking: meta.looking } : {}),
          imageCount: meta.imageCount,
          text: "",
          steps: [],
          status,
          error: null,
          sessionId: null,
          usage: null,
          createdAt: at.toISOString(),
          ...(ask ? { ask } : {}),
        },
      ];
      live.set(requestId, { text: "", steps: [] });
      save();
    },

    setStatus(requestId: string, status: StoredTurn["status"]) {
      update(requestId, (t) => ({ ...t, status }));
    },

    step(requestId: string, label: string) {
      live.get(requestId)?.steps.push(label);
      update(requestId, (t) => ({ ...t, steps: [...t.steps, label] }));
    },

    /** Text is kept in memory as it streams and written once, when the turn ends. */
    text(requestId: string, chunk: string) {
      const l = live.get(requestId);
      if (l) l.text += chunk;
    },

    finish(requestId: string, end: { ok: boolean; error: string | null; sessionId: string | null; usage: TurnUsage | null }) {
      const text = live.get(requestId)?.text ?? "";
      live.delete(requestId);
      update(requestId, ({ ask: _, ...t }) => ({ ...t, text, status: end.ok ? "done" : "failed", error: end.ok ? null : end.error, sessionId: end.sessionId ?? t.sessionId, usage: end.usage }));
    },

    /** Forgets every conversation, as signing out does. */
    clear() {
      all = [];
      resumable = [];
      live.clear();
      save();
    },
  };
}

export type MockPipTurns = ReturnType<typeof openMockPipTurns>;

export const mockPipTurns: MockPipTurns = openMockPipTurns();

/** A made-up but steady usage for a scripted turn: tokens follow the prompt and answer lengths. */
export function mockUsage(prompt: string, text: string): TurnUsage {
  const inputTokens = 40 + Math.ceil(prompt.length / 4);
  const outputTokens = Math.ceil(text.length / 4);
  return { inputTokens, outputTokens, cacheCreationTokens: 0, cacheReadTokens: 0, costUsd: Number(((inputTokens * 3 + outputTokens * 15) / 1_000_000).toFixed(6)) };
}
