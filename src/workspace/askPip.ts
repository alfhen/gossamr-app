import { useClaude } from "../claudeStore";
import { liveScreen, WORKSPACE_CONVERSATION } from "./PipPane";
import { usePrefs } from "./prefs";
import { buildScreenContext } from "./screenContext";
import { useToasts } from "./toasts";

/** Opens Pip and sends it `query` as a question about the screen. Pip only ever proposes drafts in reply. */
export function askPip(query: string) {
  const text = query.trim();
  if (!text) return;
  usePrefs.getState().setPipOpen(true);
  const conv = useClaude.getState().byTicket[WORKSPACE_CONVERSATION];
  if (conv?.turns.some((t) => t.status === "running")) {
    useToasts.getState().push("Pip is still answering. Ask again when it has finished.", "info");
    return;
  }
  void useClaude.getState().ask(WORKSPACE_CONVERSATION, text, conv?.sessionId ?? null, conv?.cwd ?? null, buildScreenContext(liveScreen()));
}
