import type { FailureAct } from "./failureHelp";
import { askPipInWorkstream } from "./askPip";
import { pipAsks } from "./runSheetLogic";
import { useRuns } from "./runsStore";

/** Does what a failed run's button says: Terminal, the install page, or asking Pip to start it again. Clean up asks first, in `FailureStep`. */
export function failureAction(id: string, act: FailureAct): void {
  if (act === "cleanup") return;
  if (act === "pip") {
    const run = useRuns.getState().runs.find((r) => r.id === id);
    if (run) void askPipInWorkstream(run, pipAsks.again(run));
    return;
  }
  void useRuns.getState().fix(id, act);
}
