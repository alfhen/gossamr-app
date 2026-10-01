import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { ImageData } from "../lib/pipImages";
import type { ScreenContext, WorkFilter } from "../types";
import { useWorkspace } from "../workspaceStore";
import { mockAsk, mockCancel, mockPipEvents, type PipDrafter } from "./mockPip";

export interface ClaudeSessions {
  /** The session to continue for the ticket, when the backend can resume it. */
  last: string | null;
}

export type ClaudeEvent =
  | { type: "started"; sessionId: string }
  | { type: "text"; text: string }
  | { type: "tool"; label: string }
  | { type: "done"; sessionId: string | null; ok: boolean; message: string | null };

export interface AskRequest {
  requestId: string;
  prompt: string;
  context: ScreenContext;
  sessionId: string | null;
  /** Screenshots for this question only, as base64. */
  images?: ImageData[];
}

/** Emitted as the `pip-view` event when Pip narrows the view the person is looking at. */
export interface PipView {
  requestId: string;
  filter: WorkFilter;
  note: string;
}

/** The browser build has no assistant to run, so it gets a scripted one that drafts into the sample backend. */
const scripted = !isTauri();

export const claude = {
  sessions: (key: string) => invoke<ClaudeSessions>("claude_sessions", { key }),
  ask: (request: AskRequest) =>
    scripted ? mockAsk(request, useWorkspace.getState().backend as Partial<PipDrafter> | null) : invoke<void>("ask_claude", { request }),
  cancel: (requestId: string) => (scripted ? Promise.resolve(mockCancel(requestId)) : invoke<void>("cancel_claude", { requestId })),
  onPipView(cb: (view: PipView) => void) {
    if (scripted) return mockPipEvents.onView((requestId, filter, note) => cb({ requestId, filter, note }));
    const p = listen<PipView>("pip-view", ({ payload }) => cb(payload));
    return () => void p.then((un) => un());
  },
  onEvent(cb: (requestId: string, e: ClaudeEvent) => void) {
    if (scripted) return mockPipEvents.on(cb);
    const p = listen<{ requestId: string } & ClaudeEvent>("claude", ({ payload }) => {
      const { requestId, ...event } = payload;
      cb(requestId, event as ClaudeEvent);
    });
    return () => void p.then((un) => un());
  },
};
