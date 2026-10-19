import { useClaude } from "../claudeStore";
import { currentContext } from "./pipHooks";
import { usePip } from "./pipStore";
import { usePrefs } from "./prefs";
import type { PipAsk } from "./runSheetLogic";
import { contextFor, focusedConversation } from "./workstreamsStore";

/**
 * Opens the Pip drawer and sends it `query` as a question about the screen, in the focused conversation: on Pip home the
 * selected workstream's (or General's), elsewhere the one the ticket on screen has, or General. While Pip
 * answers another, it waits its turn. Pip only ever proposes drafts in reply. A `query` the person wrote goes as it is; an
 * instruction the page wrote for Pip comes as a `PipAsk`, whose `shown` line is what the person's bubble shows while Pip
 * still gets the whole prompt.
 */
export function askPip(query: string | PipAsk) {
  const { prompt, shown } = typeof query === "string" ? { prompt: query, shown: null } : query;
  const text = prompt.trim();
  if (!text) return;
  usePrefs.getState().setPipOpen(true);
  const conversation = focusedConversation();
  const conv = useClaude.getState().byTicket[conversation];
  void useClaude.getState().ask(conversation, text, conv?.sessionId ?? null, contextFor(conversation, usePip.getState().pinned ?? currentContext()), shown ? { shown } : undefined);
}
