import { fromRunPhrase, runPhrase } from "../lib/runNames";
import type { Proposal } from "../types";
import { useRuns } from "./runsStore";

/** The run draft `p` came from as the person knows it, "the CA-402 review", for any line that names it. */
export function useFromRunName(p: Proposal): string {
  const runId = p.origin.type === "run" ? p.origin.runId : null;
  const run = useRuns((s) => (runId ? s.runs.find((r) => r.id === runId) : undefined));
  return fromRunPhrase(p, run);
}

/**
 * "From the CA-402 review": the run a draft came from, named by ticket and step, never by its id. With `onOpen` the name
 * opens the run.
 */
export function FromRun({ proposal: p, onOpen, className = "font-semibold text-ws-pip hover:underline" }: { proposal: Proposal; onOpen?: () => void; className?: string }) {
  const name = useFromRunName(p);
  return (
    <>
      From{" "}
      {onOpen ? (
        <button type="button" onClick={onOpen} title="Open the run this draft came from" className={className}>
          {name}
        </button>
      ) : (
        <b>{name}</b>
      )}
    </>
  );
}

/** A run named by ticket and step ("the CA-401 plan"), for a line about a run other than the draft's own. */
export function RunName({ id }: { id: string }) {
  const run = useRuns((s) => s.runs.find((r) => r.id === id));
  return <b className="font-semibold">{run ? runPhrase(run) : "an earlier run"}</b>;
}
