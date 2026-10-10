import type { WorkstreamMode, WorkstreamStage } from "../types";
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

/** What the chips need to know about the workstream whose conversation is in focus. */
export interface WorkstreamSuggestionScene {
  /** Its ticket's key; null for a ticketless workstream. */
  key: string | null;
  stage: WorkstreamStage;
  mode: WorkstreamMode;
  heldReason: string | null;
  /** A plan's description update waits for the person. */
  hasPendingPlanRewrite: boolean;
  /** A run Pip drafted waits to be read and started. */
  hasPendingStartDraft: boolean;
  /** An investigation of it finished. */
  investigated: boolean;
  /** Pip was woken since the person last wrote here. */
  woke?: boolean;
  /** The run at work, by its label ("R2"). */
  running?: string | null;
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
  /** The focused conversation is this workstream's. */
  workstream?: WorkstreamSuggestionScene;
}

const MOST = 6;

/** Where the chain goes next from a workstream's stage, once it was investigated. */
const NEXT_AFTER_INVESTIGATION: Partial<Record<WorkstreamStage, string[]>> = { investigate: ["Triage this", "Plan this"], triage: ["Plan this"] };

/**
 * Chips for a workstream's conversation: what holds it, a plan waiting for approval (which Pip answers by saying where
 * to approve it, since Pip approves nothing), a run draft waiting to be read and started, what happened while the person
 * was away, the run at work, and the next step to ask for. Empty when none applies.
 */
export function workstreamChips(w: WorkstreamSuggestionScene): string[] {
  const chips = [
    ...(w.heldReason ? ["Why is this held?"] : []),
    ...(w.hasPendingPlanRewrite ? ["Approve the plan"] : []),
    ...(w.hasPendingStartDraft ? ["What is waiting to start?"] : []),
    ...(w.woke ? ["What happened while I was away?"] : []),
    ...(w.running ? [`What is ${w.running} doing?`] : []),
    ...(w.stage === "intake" && w.key && !w.investigated && !w.hasPendingStartDraft ? [`Investigate ${w.key}`] : []),
    ...(w.investigated && !w.hasPendingStartDraft && !w.running ? (NEXT_AFTER_INVESTIGATION[w.stage] ?? []) : []),
  ];
  return chips.slice(0, MOST);
}

/** The questions worth offering as one-tap chips for what is on screen. */
export function suggestionsFor(s: SuggestionScene): string[] {
  if (s.quote) return ["Explain this", "Turn this into a ticket", "Turn this into a subtask"];
  if (s.route === "settings") return ["What can you do for me?"];
  const open = s.item ? null : s.agents?.open;
  if (open) return runChips(open);
  const ws = s.workstream ? workstreamChips(s.workstream) : [];
  if (ws.length) return ws;
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
      ...(i.open ? ["Draft a description update"] : []),
      "Create a follow-up ticket",
    ];
    return chips.slice(0, MOST);
  }
  // Pip home shows no board: its chips never filter a view the person can't see.
  if (s.route === "pip") return [...drafts, "Catch me up"];
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
      return ["What did this run find?", ...(run.ticket ? ["Draft a comment from this run"] : []), "Send it back for another pass", "Create a follow-up ticket"];
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
export function placeholderFor(s: { images: boolean; quote: boolean; itemKey: string | null; route: Route; runOpen: boolean; workstream?: boolean }): string {
  if (s.images) return "Say what to look at, or just ask…";
  if (s.quote) return "Ask about the selected text…";
  if (s.itemKey) return `Ask about ${s.itemKey}…`;
  if (s.runOpen) return "Ask about this run…";
  if (s.route === "pip") return s.workstream ? "Ask about this workstream…" : "Ask about your workstreams and agents…";
  return s.route === "agents" ? "Ask about the agents…" : "Ask about what you're looking at…";
}
