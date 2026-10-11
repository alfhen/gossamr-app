import { useClaude } from "../claudeStore";
import { WORKSPACE_CONVERSATION } from "./PipPane";
import { currentContext } from "./pipHooks";
import { usePip } from "./pipStore";
import { usePrefs } from "./prefs";

/** Opens Pip and sends it `query` as a question about the screen; while Pip answers another, it waits its turn. Pip only ever proposes drafts in reply. */
export function askPip(query: string) {
  const text = query.trim();
  if (!text) return;
  usePrefs.getState().setPipOpen(true);
  const conv = useClaude.getState().byTicket[WORKSPACE_CONVERSATION];
  void useClaude.getState().ask(WORKSPACE_CONVERSATION, text, conv?.sessionId ?? null, usePip.getState().pinned ?? currentContext());
}
