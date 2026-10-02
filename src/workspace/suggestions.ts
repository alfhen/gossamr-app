import type { ItemScene } from "./pipScene";
import type { Route } from "./tabsStore";
import { runSummaryPrompt } from "./pipRuns";

/** What the chips need to know about the agents: how many runs there are, and the open one. */
export interface AgentsSuggestionScene {
  runs: number;
  waiting: number;
  done: number;
  /** The run open in the run sheet: how it stands, and whether it has a ticket to comment on. */
  open: { stage: "needs" | "failed" | "done" | "going" | "ended"; ticket: boolean } | null;
}

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
  agents?: AgentsSuggestionScene;
}

const MOST = 6;

/** The questions worth offering as one-tap chips for what is on screen. */
export function suggestionsFor(s: SuggestionScene): string[] {
  if (s.quote) return ["Explain this", "Turn this into a ticket", "Turn this into a subtask"];
  if (s.route === "settings") return ["What can you do for me?"];
  const open = s.item ? null : s.agents?.open;
  if (open) return runChips(open);
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
  if (s.route === "agents") return agentsChips(s.agents, drafts);
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

function runChips(run: NonNullable<AgentsSuggestionScene["open"]>): string[] {
  switch (run.stage) {
    case "needs":
      return ["What is this run asking me?", "What has this run done so far?"];
    case "failed":
      return ["Why did this run fail?", "What did this run get done?"];
    case "done":
      return ["What did this run find?", ...(run.ticket ? ["Draft a comment from this run"] : []), "Create a follow-up ticket"];
    case "going":
      return ["What is this run doing?"];
    case "ended":
      return ["What happened in this run?"];
  }
}

function agentsChips(agents: AgentsSuggestionScene | undefined, drafts: string[]): string[] {
  if (!agents?.runs) return ["Which tickets would an agent help with?"];
  return [...(agents.waiting > 0 ? ["Which agents need me?"] : []), runSummaryPrompt(), ...(agents.done > 0 ? ["What did the finished runs find?"] : []), ...drafts];
}

/** The input's hint: what the next question will be about. */
export function placeholderFor(s: { images: boolean; quote: boolean; itemKey: string | null; route: Route; runOpen: boolean }): string {
  if (s.images) return "Say what to look at, or just ask…";
  if (s.quote) return "Ask about the selected text…";
  if (s.itemKey) return `Ask about ${s.itemKey}…`;
  if (s.runOpen) return "Ask about this run…";
  return s.route === "agents" ? "Ask about the agents…" : "Ask about what you're looking at…";
}
