import { createContext, useContext } from "react";
import type { Need } from "../lib/needs";

/**
 * What the decision pane on Agents already shows, so nothing else on the screen shows it again: the need open in it and the
 * drafts it holds (a draft need's own).
 */
export interface DecisionShown {
  need: Need | null;
  drafts: ReadonlySet<string>;
}

const NOTHING: DecisionShown = { need: null, drafts: new Set() };

/** Provided by the Agents view around its pane and a workstream's detail; anywhere else (the Pip pane, a peek) nothing is shown elsewhere. */
export const DecisionShownContext = createContext<DecisionShown>(NOTHING);

export const useDecisionShown = () => useContext(DecisionShownContext);

/** What the pane shows for `need` (the one open in it, if any). */
export function decisionShown(need: Need | null | undefined): DecisionShown {
  if (!need) return NOTHING;
  const drafts = new Set<string>();
  if (need.target.type === "draft") drafts.add(need.target.id);
  return { need, drafts };
}

/** Whether the pane has `need`'s kind open for workstream `workstreamId`: its paused banner then is not shown a second time. */
export const paneHas = (shown: DecisionShown, kind: Need["kind"], workstreamId: string): boolean => shown.need?.kind === kind && shown.need.workstreamId === workstreamId;
