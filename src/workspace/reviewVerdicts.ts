import { useEffect, useRef, useState } from "react";
import { stepOf } from "../lib/roles";
import type { CodeChange, ReviewView, Run } from "../types";
import { useRuns } from "./runsStore";

export function useReviewVerdicts(_runs: readonly Run[]): Record<string, ReviewView | null> {
  return {};
}

const CHANGE_RECHECK_MS = 30_000;

/**
 * The pull request each finished build opened, as the last sync saw it, asked again while a build has none: every half
 * minute, and at once whenever `again` changes (a workstream's `waitingForPr` clearing, which is a sync finding it).
 */
export function useBuildChanges(runs: readonly Run[], again: unknown = null) {
  const backend = useRuns((s) => s.backend);
  const [changes, setChanges] = useState<Record<string, CodeChange | null>>({});
  const asked = useRef(new Map<string, number>());
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), CHANGE_RECHECK_MS);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => asked.current.clear(), [again]);
  useEffect(() => {
    if (!backend) return;
    const at = Date.now();
    for (const run of runs) {
      if (stepOf(run.spec.role) !== "build" || run.state !== "done" || !run.item || run.resultComplete === false || changes[run.id]?.number != null) continue;
      if (at - (asked.current.get(run.id) ?? 0) < CHANGE_RECHECK_MS) continue;
      asked.current.set(run.id, at);
      backend.runsOutcome(run.id).then(
        (outcome) => setChanges((c) => ({ ...c, [run.id]: outcome.change })),
        () => {},
      );
    }
  }, [backend, runs, changes, tick, again]);
  return changes;
}
