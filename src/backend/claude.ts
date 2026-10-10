import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { ImageData } from "../lib/pipImages";
import type { ScreenContext, WorkFilter } from "../types";
import { useWorkspace } from "../workspaceStore";
import { mockPipEvents, type PipDrafter } from "./mockPip";
import { mockQueueAsk, mockQueueCancel, mockResume } from "./mockPipQueue";
import { mockPipTurns } from "./mockPipTurns";
import { mockOptionsFromUrl } from "./mockWatch";

export interface ClaudeSessions {
  /** The session to continue for the ticket, when the backend can resume it. */
  last: string | null;
}

export type ClaudeEvent =
  | { type: "started"; sessionId: string }
  | { type: "text"; text: string }
  | { type: "tool"; label: string }
  | { type: "done"; sessionId: string | null; ok: boolean; message: string | null; usage?: TurnUsage }
  /** The turn waits behind `ahead` turns of its conversation, or for room when that is 0. */
  | { type: "queued"; ahead: number }
  /** The turn left the queue and Pip is starting on it. */
  | { type: "running" };

/**
 * Where a `claude` event belongs besides its request id. The app sends it with every event of a turn the person didn't
 * start: a wake, `kind: wake`, in its workstream's `conversation`. `prompt` is the wake's event lines when the backend
 * says them; without it the page reads them from the stored turn.
 */
export interface EventMeta {
  conversation?: string;
  kind?: "user" | "wake";
  prompt?: string;
}

/** What became of a question when it was sent: started straight away, or queued behind `ahead` turns. */
export interface AskOutcome {
  queued: boolean;
  ahead: number;
}

/** Why a turn taken out of the queue never ran. */
export { REMOVED as REMOVED_TURN } from "./mockPipTurns";

/** The tokens and money one turn used, when the assistant reports them. */
export interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  costUsd: number | null;
}

/** How the page showed a question besides its words. Images are counted, not kept. */
export interface TurnMeta {
  quote?: string;
  looking?: string;
  imageCount: number;
}

/** One question and its answer as the backend keeps them. */
export interface StoredTurn {
  requestId: string;
  conversation: string;
  prompt: string;
  quote?: string;
  looking?: string;
  imageCount: number;
  text: string;
  steps: string[];
  status: "queued" | "running" | "done" | "failed";
  error: string | null;
  sessionId: string | null;
  usage: TurnUsage | null;
  createdAt: string;
  /** `wake` for a turn the supervisor started, with its event lines as `prompt`; a person's question otherwise. */
  kind?: "user" | "wake";
}

export interface AskRequest {
  requestId: string;
  prompt: string;
  context: ScreenContext;
  sessionId: string | null;
  /** Screenshots for this question only, as base64. */
  images?: ImageData[];
  /** Where the turn is kept: the Pip pane's `general` or a workstream's `ws:<id>`, or a ticket key for the classic drawer. */
  conversation?: string;
  meta?: TurnMeta;
  /** `wake` for a turn the supervisor started; the sample backend's own wake turns are asked this way. */
  kind?: "user" | "wake";
}

/** Emitted as the `pip-view` event when Pip narrows the view the person is looking at. */
export interface PipView {
  requestId: string;
  filter: WorkFilter;
  note: string;
}

/** The browser build has no assistant to run, so it gets a scripted one that drafts into the sample backend. */
const scripted = !isTauri();

/** The sample backend the scripted Pip drafts into, with any turns a reload cut off asked again first. */
function scriptedDrafter(): Partial<PipDrafter> | null {
  const drafter = useWorkspace.getState().backend as Partial<PipDrafter> | null;
  mockResume(drafter, mockOptionsFromUrl().pipPace);
  return drafter;
}

export const claude = {
  sessions: (key: string) => invoke<ClaudeSessions>("claude_sessions", { key }),
  /** Sends a question. It runs now, or waits its turn behind the one Pip is answering in the same conversation. */
  ask: (request: AskRequest): Promise<AskOutcome> =>
    scripted
      ? Promise.resolve(mockQueueAsk(request, scriptedDrafter(), mockOptionsFromUrl().pipPace))
      : invoke<AskOutcome>("ask_claude", { request }),
  /** The stored turns of `conversation`, oldest first, with what a running turn has said so far. */
  turns: (conversation: string) => (scripted ? Promise.resolve((scriptedDrafter(), mockPipTurns.turns(conversation))) : invoke<StoredTurn[]>("pip_turns", { conversation })),
  /** Stops the turn Pip is answering, or takes one still waiting out of the queue. */
  cancel: (requestId: string) => (scripted ? Promise.resolve(mockQueueCancel(requestId)) : invoke<void>("cancel_claude", { requestId })),
  onPipView(cb: (view: PipView) => void) {
    if (scripted) return mockPipEvents.onView((requestId, filter, note) => cb({ requestId, filter, note }));
    const p = listen<PipView>("pip-view", ({ payload }) => cb(payload));
    return () => void p.then((un) => un());
  },
  /** Every event of every turn, with where it belongs when the turn is one the page didn't ask (a wake). */
  onEvent(cb: (requestId: string, e: ClaudeEvent, meta?: EventMeta) => void) {
    if (scripted) return mockPipEvents.on(cb);
    const p = listen<{ requestId: string } & EventMeta & ClaudeEvent>("claude", ({ payload }) => {
      const { requestId, conversation, kind, prompt, ...event } = payload;
      const meta: EventMeta = { ...(conversation ? { conversation } : {}), ...(kind ? { kind } : {}), ...(prompt ? { prompt } : {}) };
      cb(requestId, event as ClaudeEvent, Object.keys(meta).length ? meta : undefined);
    });
    return () => void p.then((un) => un());
  },
};
