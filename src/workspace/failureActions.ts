import type { FailureAct } from "./failureHelp";
import { useRuns } from "./runsStore";

/** Does what a failed launch's main button says: Terminal, or the install page. */
export function failureAction(id: string, act: FailureAct): void {
  void useRuns.getState().fix(id, act);
}
