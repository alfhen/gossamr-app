import { createContext, useContext } from "react";
import type { Need } from "../lib/needs";
import type { WorkstreamView } from "../types";

/**
 * What Pip home's decision pane already shows, so nothing else on the screen shows it again: the need open in it and the
 * drafts it holds (a draft need's own, and the review draft folded into an escalation).
 */
export interface DecisionShown {
  need: Need | null;
  drafts: ReadonlySet<string>;
}

const NOTHING: DecisionShown = { need: null, drafts: new Set() };

/** Provided by Pip home around its pane, its timeline and its step rail; anywhere else (the Pip pane, a peek) nothing is shown elsewhere. */
export const DecisionShownContext = createContext<DecisionShown>(NOTHING);

export const useDecisionShown = () => useContext(DecisionShownContext);

/** What the pane shows for `need` (the one open in it, if any), from the workstreams' views. */
export function decisionShown(need: Need | null | undefined, views: readonly WorkstreamView[]): DecisionShown {
  if (!need) return NOTHING;
  const drafts = new Set<string>();
  if (need.target.type === "draft") drafts.add(need.target.id);
  if (need.kind === "escalation") {
    const review = views.find((v) => v.workstream.id === need.workstreamId)?.escalation?.reviewDraft;
    if (review) drafts.add(review);
  }
  return { need, drafts };
}

/** Whether the pane has `need`'s kind open for workstream `workstreamId`: its escalation card or held banner then is not shown a second time. */
export const paneHas = (shown: DecisionShown, kind: Need["kind"], workstreamId: string): boolean => shown.need?.kind === kind && shown.need.workstreamId === workstreamId;
