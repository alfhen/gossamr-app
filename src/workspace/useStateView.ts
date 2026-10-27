import type { Run } from "../types";
import { useWorkspace } from "../workspaceStore";
import { runApproved, stateView, type StateView } from "./agentsLogic";

/** `stateView` of a run as the drafts stand: a done run whose main draft was applied reads "Approved", not "Ready to review". */
export function useStateView(run: Pick<Run, "id" | "state" | "lastProgressAt" | "slotWaitSince"> & { spec: Pick<Run["spec"], "role"> }, now: number): StateView {
  const approved = useWorkspace((s) => run.state === "done" && runApproved(run, Object.values(s.proposals)));
  return stateView(run, now, approved);
}
