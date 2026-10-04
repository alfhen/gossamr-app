import { targetOf } from "../lib/proposals";
import type { Proposal, Run } from "../types";
import { needsPerson } from "./agentsLogic";

export type Waiting = { type: "draft"; proposal: Proposal; at: string } | { type: "answer"; run: Run; at: string } | { type: "finished"; run: Run; at: string };

export const FILTERS = ["all", "drafts", "answers", "sendBacks", "runs"] as const;
export type WaitingFilter = (typeof FILTERS)[number];

export const FILTER_LABEL: Record<WaitingFilter, string> = { all: "Everything", drafts: "Drafts", answers: "Answers", sendBacks: "Send-backs", runs: "Runs" };

export function groupOf(w: Waiting): Exclude<WaitingFilter, "all"> {
  if (w.type === "answer") return "answers";
  if (w.type === "finished") return "runs";
  const t = w.proposal.intent.type;
  return t === "followUp" ? "sendBacks" : t === "startRun" ? "runs" : "drafts";
}

const open = (p: Proposal) => p.state.type === "pending" || p.state.type === "applying";

/**
 * Everything waiting for the person, newest first: Pip's and the agents' drafts, runs that ask a question, and, when Pip is not
 * reviewing, finished runs nobody has read.
 */
export function waitingItems(proposals: readonly Proposal[], runs: readonly Run[], read: ReadonlySet<string>, reviewing: boolean): Waiting[] {
  const drafts = proposals.filter(open).map((proposal): Waiting => ({ type: "draft", proposal, at: proposal.createdAt }));
  const asking = runs.filter(needsPerson).map((run): Waiting => ({ type: "answer", run, at: run.lastProgressAt }));
  const finished = reviewing ? [] : runs.filter((r) => r.state === "done" && !r.pip && !read.has(r.id)).map((run): Waiting => ({ type: "finished", run, at: run.endedAt ?? run.lastProgressAt }));
  const all = [...drafts, ...asking, ...finished];
  // Drafts made in the same moment keep the order they were made in, which is the reverse of how the list holds them.
  return all.map((w, i) => ({ w, i })).sort((a, b) => b.w.at.localeCompare(a.w.at) || b.i - a.i).map(({ w }) => w);
}

export function waitingCounts(items: readonly Waiting[]): Record<WaitingFilter, number> {
  const counts: Record<WaitingFilter, number> = { all: items.length, drafts: 0, answers: 0, sendBacks: 0, runs: 0 };
  for (const w of items) counts[groupOf(w)] += 1;
  return counts;
}

export interface ItemManagerState {
  needsYou: boolean;
  /** Pending drafts Pip made on the ticket. */
  drafted: number;
  checked: boolean;
}

/** What the board badges say about one ticket. */
export function itemManagerState(key: string, proposals: readonly Proposal[], runs: readonly Run[]): ItemManagerState {
  const drafted = proposals.filter((p) => p.createdBy === "pip" && open(p) && targetOf(p.intent)?.key === key).length;
  const mine = runs.filter((r) => r.item?.key === key);
  const needsYou = drafted > 0 || mine.some(needsPerson);
  return { needsYou, drafted, checked: !needsYou && mine.some((r) => r.pip?.kind === "nothing") };
}
