import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
export interface SessionInfo {
  id: string;
  title: string;
  cwd: string;
  updated: string;
  source: "cli" | "desktop" | "app";
}

export interface ClaudeSessions {
  last: { id: string; cwd: string } | null;
  recent: SessionInfo[];
}

export type ClaudeEvent =
  | { type: "started"; sessionId: string }
  | { type: "text"; text: string }
  | { type: "tool"; label: string }
  | { type: "done"; sessionId: string | null; ok: boolean; message: string | null };

export interface AskRequest {
  requestId: string;
  ticketKey: string;
  prompt: string;
  sessionId: string | null;
  cwd: string | null;
}

export const claude = {
  sessions: (key: string) => invoke<ClaudeSessions>("claude_sessions", { key }),
  ask: (request: AskRequest) => invoke<void>("ask_claude", { request }),
  cancel: (requestId: string) => invoke<void>("cancel_claude", { requestId }),
  onEvent(cb: (requestId: string, e: ClaudeEvent) => void) {
    const p = listen<{ requestId: string } & ClaudeEvent>("claude", ({ payload }) => {
      const { requestId, ...event } = payload;
      cb(requestId, event as ClaudeEvent);
    });
    return () => void p.then((un) => un());
  },
};
