import type { Run } from "../types";

/** What was typed for each question, kept while its card is closed and opened again; keyed by run and question so a new question starts empty. */
const keptAnswers = new Map<string, string>();
export const answerKey = (run: Pick<Run, "id" | "needs">) => `${run.id}:${run.needs ?? ""}`;
export const keptAnswer = (key: string) => keptAnswers.get(key);
export const setKeptAnswer = (key: string, text: string) => void keptAnswers.set(key, text);
export const dropKeptAnswer = (key: string) => void keptAnswers.delete(key);
/** Keeps `text` as the answer to `run`'s question (what typing does), so the card shows it when it is drawn again. */
export const keepAnswer = (run: Run, text: string) => setKeptAnswer(answerKey(run), text);
/** Forget everything kept for a run (tests, and when it no longer needs an answer). */
export function forgetKeptAnswers(runId?: string) {
  for (const k of [...keptAnswers.keys()]) if (!runId || k.startsWith(`${runId}:`)) keptAnswers.delete(k);
}
/** Forgets what was kept for every run in `runs` that is no longer waiting for an answer, so a later question, even the same words, starts from its own draft. Called on each runs load, with or without a card on screen. */
export function forgetSettledAnswers(runs: readonly Pick<Run, "id" | "state">[]) {
  for (const r of runs) if (r.state !== "needsAnswer" && r.state !== "stopped") forgetKeptAnswers(r.id);
}
