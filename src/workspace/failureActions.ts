import { failureHelp, type FailureAct } from "./failureHelp";
import { useRunSetup } from "./runSetupStore";
import { useRuns } from "./runsStore";

/** Does what a failed launch's main button says. Starting again is the one step that leaves the run for another sheet. */
export function failureAction(id: string, act: FailureAct): void {
  const runs = useRuns.getState();
  if (act !== "start") return void runs.fix(id, act);
  const run = runs.runs.find((r) => r.id === id);
  if (!run || !failureHelp(run)) return;
  runs.closeSheet();
  if (run.item) void useRunSetup.getState().begin({ item: run.item });
  else runs.setPicking(true);
}
