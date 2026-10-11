import { useClaude } from "../claudeStore";
import { currentContext } from "./pipHooks";
import { usePip } from "./pipStore";
import { usePrefs } from "./prefs";
import { useTabs } from "./tabsStore";
import { contextFor, focusedConversation } from "./workstreamsStore";

/**
 * Opens Pip and sends it `query` as a question about the screen, in the focused conversation: on Pip home the one it
 * shows, elsewhere the one the pane shows (the focused workstream's, or General). Pip home has no pane to open. While Pip
 * answers another, it waits its turn. Pip only ever proposes drafts in reply.
 */
export function askPip(query: string) {
  const text = query.trim();
  if (!text) return;
  if (useTabs.getState().route !== "pip") usePrefs.getState().setPipOpen(true);
  const conversation = focusedConversation();
  const conv = useClaude.getState().byTicket[conversation];
  void useClaude.getState().ask(conversation, text, conv?.sessionId ?? null, contextFor(conversation, usePip.getState().pinned ?? currentContext()));
}
