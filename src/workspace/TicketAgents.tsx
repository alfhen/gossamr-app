import { itemKey } from "../lib/filter";
import { HeaderStatus } from "./StatusPill";
import type { ItemRef, Run, WorkstreamView } from "../types";
import { RunLabel } from "./AgentCard";
import { StateChip } from "./AgentParts";
import { progressText, runTitle } from "./agentsLogic";
import { useRuns } from "./runsStore";
import { openOnAgents } from "./workstreamsStore";
import { Button } from "../components/Button";

export const runsOfTicket = (runs: readonly Run[], ref: ItemRef) => runs.filter((r) => r.item && itemKey(r.item) === itemKey(ref));

/**
 * The workstream line at the head of "Agents on this ticket": its title and its status pill, and with
 * `onOpen` a link to the workstream on Agents.
 */
export function WorkstreamLine({ workstream, onOpen }: { workstream: WorkstreamView; onOpen?(id: string): void }) {
  return (
    <p data-workstream={workstream.workstream.id} className="m-0 mb-1.5 flex min-w-0 flex-wrap items-center gap-1.5 text-sm text-ws-ink2">
      <span aria-hidden className="text-ws-pip">
        ◆
      </span>
      <span className="min-w-0 truncate">Workstream: {workstream.workstream.title}</span>
      <HeaderStatus view={workstream} />
      {onOpen && (
        <Button variant="plain" pip size="sm" className="ml-auto shrink-0" data-open-workstream onClick={() => onOpen(workstream.workstream.id)}>
          Open in Agents
        </Button>
      )}
    </p>
  );
}

/** A ticket's runs, each with its short name (`R1`) when `labels` has one. */
export function TicketAgentRows({ runs, now, title, labels = {}, onOpen }: { runs: readonly Run[]; now: number; title: string | null; labels?: Readonly<Record<string, string>>; onOpen(id: string): void }) {
  if (!runs.length) return <p className="m-0 text-ws-ink3">None yet. Ask Pip to start one.</p>;
  return (
    <ul className="m-0 grid list-none gap-1.5 p-0">
      {runs.map((r) => (
        <li key={r.id}>
          <button type="button" onClick={() => onOpen(r.id)} data-state={r.state} className="grid w-full gap-1 rounded-[10px] border border-ws-sep bg-ws-win px-3 py-2 text-left hover:border-ws-sep2">
            <span className="flex min-w-0 items-center gap-2">
              <RunLabel label={labels[r.id]} />
              <b className="min-w-0 truncate font-semibold">{runTitle(r, title)}</b>
              <span className="ml-auto shrink-0">
                <StateChip run={r} now={now} />
              </span>
            </span>
            <span className="truncate text-sm text-ws-ink2">{r.state === "working" || r.state === "launching" || r.state === "queued" ? progressText(r) : (r.needs ?? r.summary ?? r.result ?? r.error ?? "").split("\n")[0]}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** "Agents on this ticket": the ticket's open workstream, if it has one, with its stage, then its runs labelled R1, R2 within it. */
export function TicketAgentsView({ runs, now, title, workstream, onOpen, onOpenWorkstream }: { runs: readonly Run[]; now: number; title: string | null; workstream: WorkstreamView | null; onOpen(id: string): void; onOpenWorkstream?(id: string): void }) {
  const labels = workstream ? Object.fromEntries(workstream.labels) : undefined;
  return (
    <>
      {workstream && <WorkstreamLine workstream={workstream} onOpen={onOpenWorkstream} />}
      <TicketAgentRows runs={runs} now={now} title={title} labels={labels} onOpen={onOpen} />
    </>
  );
}

export function TicketAgents({ item, title, workstream = null }: { item: ItemRef; title: string; workstream?: WorkstreamView | null }) {
  const runs = useRuns((s) => s.runs);
  const mine = runsOfTicket(runs, item);
  return <TicketAgentsView runs={mine} now={Date.now()} title={title} workstream={workstream} onOpen={(id) => useRuns.getState().openRun(id, { stay: true })} onOpenWorkstream={openOnAgents} />;
}
