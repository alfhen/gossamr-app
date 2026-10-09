import type { Intent, ItemRef, Proposal, ProposalMaker } from "../types";

/** Fails to compile when a switch over a union misses a case, and throws if one slips through at run time. */
export function unreachable(value: never): never {
  throw new Error(`Unhandled case: ${JSON.stringify(value)}`);
}

/** The existing item a draft is about; a new item has none yet. */
export function targetOf(intent: Intent): ItemRef | null {
  switch (intent.type) {
    case "comment":
    case "transition":
    case "update":
    case "rewrite":
      return intent.item;
    case "link":
      return intent.from;
    case "subtasks":
      return intent.parent;
    case "startRun":
    case "followUp":
      return intent.item;
    case "create":
      return null;
    default:
      return unreachable(intent);
  }
}

/** The drafts a screen that can only approve with `proposalsApprove` may offer: a run is approved with `runsApprove` after its prompt is shown, a follow-up with `runsSendFollowUp`. */
export function withoutRunDrafts(proposals: Proposal[]): Proposal[] {
  return proposals.filter((p) => p.intent.type !== "startRun" && p.intent.type !== "followUp");
}

/** Drafts Pip made while answering one question, oldest first so they read in the order they were proposed. */
export function draftsForTurn(proposals: Proposal[], requestId: string): Proposal[] {
  return proposals
    .filter((p) => p.origin.type === "chat" && p.origin.requestId === requestId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** Open drafts on a ticket that no conversation on screen accounts for, such as ones made before a restart. */
export function earlierDrafts(proposals: Proposal[], ticketKey: string, requestIds: string[]): Proposal[] {
  return proposals
    .filter((p) => {
      const open = p.state.type === "pending" || p.state.type === "applying";
      const shown = p.origin.type === "chat" && requestIds.includes(p.origin.requestId);
      return open && !shown && targetOf(p.intent)?.key === ticketKey;
    })
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** The workstream a draft belongs to: the one it was made in, else the one a run it would start is linked to. */
export function workstreamOf(p: Proposal): string | null {
  const made = p.origin.type === "chat" || p.origin.type === "run" ? (p.origin.workstream ?? null) : null;
  return made ?? (p.intent.type === "startRun" ? (p.intent.spec.workstream ?? null) : null);
}

/**
 * Whether a workstream's conversation shows the draft: one of the workstream's own, or an open one on its ticket. Pip's
 * `[Workstream]` block lists the same open drafts, so the pane never hides one Pip is told about.
 */
export function inWorkstreamPane(p: Proposal, ws: { id: string; itemKey: string | null; connectionId: string }): boolean {
  if (workstreamOf(p) === ws.id) return true;
  const open = p.state.type === "pending" || p.state.type === "applying";
  const target = targetOf(p.intent);
  return open && !!ws.itemKey && target?.key === ws.itemKey && target.connectionId === ws.connectionId;
}

/** Whether an agent run left this draft for the person. Drafts stored before `agent` existed say `user`. */
export function leftByRun(p: Proposal): boolean {
  return p.origin.type === "run" && (p.createdBy === "agent" || p.createdBy === "user");
}

/** Who made a draft, as a short phrase. */
export function makerName(by: ProposalMaker): string {
  switch (by) {
    case "user":
      return "You";
    case "pip":
      return "Pip";
    case "autopilot":
      return "Autopilot";
    case "agent":
      return "An agent run";
    default:
      return unreachable(by);
  }
}
