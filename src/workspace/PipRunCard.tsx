import type { Run } from "../types";
import { itemKey } from "../lib/filter";
import { labelsByRun } from "../lib/workstreamStage";
import { AutoStarted, RunLabel } from "./AgentCard";
import { useWorkspace } from "../workspaceStore";
import { useAgentsEnabled } from "./agentsFlag";
import { runTitle, stateView } from "./agentsLogic";
import { Dot, TONE, rowText } from "./AgentParts";
import { stripRuns } from "./pipRuns";
import { useRuns } from "./runsStore";

interface CardProps {
  run: Run;
  now: number;
  /** The ticket's title when it is cached. */
  ticketTitle: string | null;
  /** The run's short name in its workstream (`R1`), when it is in one. */
  label?: string;
  onOpen(): void;
  /** Stepped to from the keyboard, as on Pip home's step rail: it takes focus from code and shows a ring. */
  focusable?: boolean;
}

/** A run in Pip's pane: its state, what it is doing, and a way into the run's sheet. */
export function PipRunCard({ run, now, ticketTitle, label, onOpen, focusable = false }: CardProps) {
  const view = stateView(run, now);
  const tone = TONE[view.tone];
  const title = runTitle(run, ticketTitle);
  return (
    <article
      data-run-id={run.id}
      data-state={run.state}
      aria-label={`${title}, ${view.label}`}
      tabIndex={focusable ? -1 : undefined}
      className="flex items-center gap-2 rounded-[10px] border border-ws-sep bg-ws-win py-1.5 pr-2 pl-2.5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ws-pip"
    >
      <Dot tone={view.tone} live={view.live} />
      <div className="grid min-w-0 flex-1 leading-snug">
        <span className="flex min-w-0 items-baseline gap-1.5">
          <RunLabel label={label} />
          {run.item && <span className="shrink-0 font-mono text-xs font-semibold text-ws-ink2">{run.item.key}</span>}
          <b className="min-w-0 truncate text-sm font-semibold">{title}</b>
        </span>
        <span className="min-w-0 truncate text-xs text-ws-ink3">
          <span className={`font-semibold ${tone.text}`}>{view.label}</span> · {rowText(run, now)}
        </span>
        <AutoStarted run={run} />
      </div>
      <button type="button" onClick={onOpen} aria-label={`Open ${title}`} data-run-open className="shrink-0 rounded-md border border-ws-sep2 px-2 py-px text-sm font-semibold hover:border-ws-pip hover:text-ws-pip focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ws-pip">
        Open
      </button>
    </article>
  );
}

/**
 * Up to three live runs above the drafts: the ones that need the person, then the ones working. In a workstream's
 * conversation (`workstream`), only that workstream's runs. Absent while agents are off or nothing is going.
 */
export function PipRunStripView({ runs, enabled, now, workstream = null, titleOf, onOpen }: { runs: readonly Run[]; enabled: boolean; now: number; workstream?: string | null; titleOf(run: Run): string | null; onOpen(run: Run): void }) {
  const labels = labelsByRun(runs);
  const shown = stripRuns(workstream ? runs.filter((r) => r.spec.workstream === workstream) : runs);
  if (!enabled || !shown.length) return null;
  return (
    <section aria-label="Your agents" className="grid gap-1.5">
      <h3 className="m-0 text-xs font-semibold tracking-wide text-ws-ink3 uppercase">
        Your agents <span className="font-normal">{shown.length}</span>
      </h3>
      {shown.map((run) => (
        <PipRunCard key={run.id} run={run} now={now} ticketTitle={titleOf(run)} label={labels.get(run.id)} onOpen={() => onOpen(run)} />
      ))}
    </section>
  );
}

export function PipRunStrip({ workstream = null }: { workstream?: string | null }) {
  const enabled = useAgentsEnabled();
  const runs = useRuns((s) => s.runs);
  const items = useWorkspace((s) => s.items);
  return (
    <PipRunStripView
      runs={runs}
      enabled={enabled}
      now={Date.now()}
      workstream={workstream}
      titleOf={(run) => (run.item ? (items[itemKey(run.item)]?.title ?? null) : null)}
      onOpen={(run) => useRuns.getState().openRun(run.id, { stay: true })}
    />
  );
}
