import type { Run } from "../types";
import { needsAttention, runTitle, stateView, yourAgents } from "./agentsLogic";

export const STRIP_SHOWN = 3;

/**
 * The runs Pip's pane keeps in view, in order: the ones waiting on the person first, failed ones they haven't looked at
 * among them as the Needs you tray lists them, then the ones still working. The pane shows the first `STRIP_SHOWN`.
 */
export function stripRuns(runs: readonly Run[], dismissed: ReadonlySet<string> = new Set()): Run[] {
  const newest = (a: Run, b: Run) => b.lastProgressAt.localeCompare(a.lastProgressAt) || a.id.localeCompare(b.id);
  // Your agents, every one of them (`yourAgents`), so "3 of 6" counts what every other count of agents counts.
  const mine = yourAgents(runs, dismissed);
  const needs = mine.filter((r) => needsAttention(r, dismissed)).sort(newest);
  const going = mine.filter((r) => !needsAttention(r, dismissed)).sort(newest);
  return [...needs, ...going];
}

/** The open run in words for "What I can see right now", such as "Investigate CA-1 · Working". */
export const describeRun = (run: Run, ticketTitle: string | null | undefined, now: number) => `${runTitle(run, ticketTitle)} · ${stateView(run, now).label}`;
