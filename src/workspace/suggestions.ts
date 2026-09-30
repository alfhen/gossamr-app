import type { ItemScene } from "./pipScene";
import type { Route } from "./tabsStore";

export interface SuggestionScene {
  route: Route;
  /** Text selected in the peek sheet. */
  quote: boolean;
  marked: number;
  item: ItemScene | null;
  pendingDrafts: number;
  /** Pending drafts on the open ticket. */
  itemDrafts: number;
  unassignedInView: number;
  shown: number;
  filtered: boolean;
}

const MOST = 6;

/** The questions worth offering as one-tap chips for what is on screen. */
export function suggestionsFor(s: SuggestionScene): string[] {
  if (s.quote) return ["Explain this", "Turn this into a ticket", "Turn this into a subtask"];
  if (s.route === "settings") return ["What can you do for me?"];
  const drafts = s.pendingDrafts > 0 ? ["Which drafts are safe to approve?"] : [];
  if (s.item) {
    const i = s.item;
    const chips = [
      "What do I need to do here?",
      i.waitingOn ? "Draft a reply" : i.staleDays !== null ? "Draft a nudge" : "Draft a comment on this one",
      ...(i.blockedBy || i.linked ? ["Show the dependency chain"] : []),
      ...(i.unassigned ? ["Suggest an owner"] : []),
      ...(i.open ? ["Break into subtasks"] : []),
      ...(s.itemDrafts > 0 ? ["Is my draft here good to post?"] : []),
      "Create a follow-up ticket",
    ];
    return chips.slice(0, MOST);
  }
  if (s.route === "activity") return [...drafts, "What happened today?", "What needs my reply?"];
  if (s.marked > 0) return ["Summarise the ticked tickets", "Which should I do first?", "Draft a comment on each of these"];
  return [
    ...(s.shown === 0 && s.filtered ? ["Why is this empty?"] : []),
    "Show stale tickets",
    "What is blocked?",
    s.unassignedInView > 0 ? "Show unassigned tickets" : "Show my tickets",
    ...drafts,
    "Catch me up",
  ].slice(0, MOST);
}
