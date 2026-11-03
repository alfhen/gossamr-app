import { useClaude } from "../claudeStore";
import { currentContext } from "./pipHooks";
import { usePip } from "./pipStore";
import { usePrefs } from "./prefs";
import type { PipAsk } from "./runSheetLogic";
import { workstreamConversation } from "../lib/conversations";
import type { Run } from "../types";
import { contextFor, focusedConversation, useWorkstreams } from "./workstreamsStore";

/**
 * Opens the Pip drawer and sends it `query` as a question about the screen, in `conversation` or else the focused one: the
 * workstream open on Agents, the one the ticket on screen has, or General. While Pip answers another, it waits its turn. A
 * `query` the person wrote goes as it is; an instruction the page wrote for Pip comes as a `PipAsk`, whose `shown` line is
 * what the person's bubble shows while Pip still gets the whole prompt.
 */
export function askPip(query: string | PipAsk, conversation: string = focusedConversation()) {
  const { prompt, shown } = typeof query === "string" ? { prompt: query, shown: null } : query;
  const text = prompt.trim();
  if (!text) return;
  usePrefs.getState().setPipOpen(true);
  const conv = useClaude.getState().byTicket[conversation];
  void useClaude.getState().ask(conversation, text, conv?.sessionId ?? null, contextFor(conversation, usePip.getState().pinned ?? currentContext()), shown ? { shown } : undefined);
}

/** Asks Pip in the workstream `run` belongs to, or in the one on its ticket, which opens first when it has none. */
export async function askPipInWorkstream(run: Pick<Run, "item" | "spec">, query: PipAsk) {
  const workstreams = useWorkstreams.getState();
  let id = run.spec.workstream ?? (run.item ? workstreams.forItem(run.item.key, run.item.connectionId)?.workstream.id : undefined);
  if (!id && run.item) id = (await workstreams.start(run.item))?.workstream.id;
  askPip(query, id ? workstreamConversation(id) : undefined);
}
