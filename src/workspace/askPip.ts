import { useClaude } from "../claudeStore";
import { currentContext } from "./pipHooks";
import { usePip } from "./pipStore";
import { usePrefs } from "./prefs";
import { contextFor, paneConversation } from "./workstreamsStore";

/** Opens Pip and sends it `query` as a question about the screen, in the conversation the pane shows (the focused workstream's, or General); while Pip answers another, it waits its turn. Pip only ever proposes drafts in reply. */
export function askPip(query: string) {
  const text = query.trim();
  if (!text) return;
  usePrefs.getState().setPipOpen(true);
  const conversation = paneConversation();
  const conv = useClaude.getState().byTicket[conversation];
  void useClaude.getState().ask(conversation, text, conv?.sessionId ?? null, contextFor(conversation, usePip.getState().pinned ?? currentContext()));
}
