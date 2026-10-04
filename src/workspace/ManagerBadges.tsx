import { useMemo } from "react";
import type { Run } from "../types";
import { useWorkspace } from "../workspaceStore";
import { useRuns } from "./runsStore";
import { useManagerOn } from "./managerProto";
import { itemManagerState } from "./managerLogic";

const CHIP = "inline-flex items-center gap-1 rounded-full px-1.5 text-xs leading-[1.5] font-semibold whitespace-nowrap";

/** What Pip as manager has to say about a ticket, as small badges on its card. Nothing unless the prototype is on. */
export function CardBadges({ itemKey }: { itemKey: string }) {
  const on = useManagerOn();
  const proposals = useWorkspace((s) => s.proposals);
  const runs = useRuns((s) => s.runs);
  const state = useMemo(() => (on ? itemManagerState(itemKey, Object.values(proposals), runs) : null), [on, itemKey, proposals, runs]);
  if (!state || (!state.needsYou && !state.drafted && !state.checked)) return null;
  return (
    <div data-manager-badges className="mt-1.5 flex flex-wrap items-center gap-1">
      {state.needsYou && <span className={`${CHIP} bg-ws-pip text-ws-on-pip`}>needs you</span>}
      {state.drafted > 0 && <span className={`${CHIP} bg-ws-pip-soft text-ws-pip`}>✦ Pip drafted {state.drafted}</span>}
      {state.checked && <span className={`${CHIP} bg-ws-done-soft text-ws-done`}>✓ checked by Pip</span>}
    </div>
  );
}

/** What Pip decided about a finished run, on the run's row, card and sheet. */
export function RunVerdictChip({ run }: { run: Pick<Run, "pip"> }) {
  const on = useManagerOn();
  if (!on || !run.pip) return null;
  const quiet = run.pip.kind === "nothing";
  return (
    <span data-pip-verdict={run.pip.kind} className={`${CHIP} ${quiet ? "bg-ws-done-soft text-ws-done" : "bg-ws-pip-soft text-ws-pip"}`}>
      {quiet ? "✓ " : "✦ "}
      {run.pip.text}
    </span>
  );
}
