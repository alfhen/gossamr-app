import { useMemo } from "react";
import { labelsByRun } from "../lib/workstreamStage";
import type { Intent, Proposal, ProposalEdit, Run } from "../types";
import { useRuns } from "./runsStore";

export type RunAnswerIntent = Extract<Intent, { type: "runAnswer" }>;

/** Why an answer draft can't be sent: the run answered elsewhere, finished or stopped since it was drafted. */
export const NOT_WAITING = "This run isn't waiting for an answer any more";

/** The run an answer is for, as people name it: its label in its workstream ("R1"), else the session id, else a prefix of the run id. */
export const answerRunLabel = (i: RunAnswerIntent, label?: string | null) => label ?? i.shortId ?? i.runId.slice(0, 8);

export const answerTitle = (i: RunAnswerIntent, label?: string | null) => `Answer for ${answerRunLabel(i, label)}`;

/** How the run an answer draft is for stands now. */
export interface AnswerRun {
  /** Its label in its workstream ("R1"), when it has one. */
  label: string | null;
  /** What it asks: its live question while it waits, else the one the draft kept. */
  question: string | null;
  /** It is waiting for an answer, so the draft may be sent. */
  waiting: boolean;
}

/** How the run `i` answers stands among `runs`. */
export function answerRun(i: RunAnswerIntent, runs: readonly Run[]): AnswerRun {
  const run = runs.find((r) => r.id === i.runId);
  const waiting = run?.state === "needsAnswer";
  return { label: run ? (labelsByRun(runs).get(run.id) ?? null) : null, question: (waiting && run?.needs?.trim()) || i.question, waiting };
}

/** `answerRun` for an answer draft, from the live runs; null for any other draft. */
export function useAnswerRun(p: Proposal): AnswerRun | null {
  const runs = useRuns((s) => s.runs);
  return useMemo(() => (p.intent.type === "runAnswer" ? answerRun(p.intent, runs) : null), [p.intent, runs]);
}

/** ⌘↵ or Ctrl+↵ in an answer's reply sends it, as Send answer does. */
export const isSendKey = (ev: { key: string; metaKey: boolean; ctrlKey: boolean; altKey?: boolean; shiftKey?: boolean }) => ev.key === "Enter" && (ev.metaKey || ev.ctrlKey) && !ev.altKey && !ev.shiftKey;

/**
 * Sends an answer draft the person may have edited: their edit is saved first, then the reply they read goes, so what is
 * sent is never other than what the card showed.
 */
export async function editThenSend(id: string, edit: ProposalEdit | null, message: string, to: { saveEdit(id: string, edit: ProposalEdit): Promise<unknown>; send(id: string, message: string): Promise<unknown> }) {
  if (edit) await to.saveEdit(id, edit);
  await to.send(id, message);
}
