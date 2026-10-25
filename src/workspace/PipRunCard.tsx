import type { Run } from "../types";
import { itemKey } from "../lib/filter";
import { labelsByRun } from "../lib/workstreamStage";
import { AutoStarted, ReadOnlyBadge, RunLabel } from "./AgentCard";
import { useWorkspace } from "../workspaceStore";
import { runTitle, waitsForSlot } from "./agentsLogic";
import { useStateView } from "./useStateView";
import { Dot, RowText, TONE } from "./AgentParts";
import { STRIP_SHOWN, stripRuns } from "./pipRuns";
import { useRuns } from "./runsStore";
import { useTabs } from "./tabsStore";

interface CardProps {
  run: Run;
  now: number;
  /** The ticket's title when it is cached. */
  ticketTitle: string | null;
  /** The run's short name in its workstream (`R1`), when it is in one. */
  label?: string;
  onOpen(): void;
  /** Stepped to from the keyboard, as on a workstream's step rail: it takes focus from code and shows a ring. */
  focusable?: boolean;
}

/** A run in Pip's pane: its state, what it is doing, and a way into the run's sheet. */
export function PipRunCard({ run, now, ticketTitle, label, onOpen, focusable = false }: CardProps) {
  const view = useStateView(run, now);
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
          <ReadOnlyBadge run={run} />
        </span>
        <span className="min-w-0 truncate text-xs text-ws-ink3">
          {waitsForSlot(run) ? (
            <span data-slot-wait className={`font-semibold ${tone.text}`}>
              <RowText run={run} now={now} />
            </span>
          ) : (
            <>
              <span className={`font-semibold ${tone.text}`}>{view.label}</span> · <RowText run={run} now={now} />
            </>
          )}
        </span>
        <AutoStarted run={run} />
      </div>
      <button type="button" onClick={onOpen} aria-label={`Open ${title}`} data-run-open className="shrink-0 rounded-md border border-ws-sep2 px-2 py-px text-sm font-semibold hover:border-ws-pip hover:text-ws-pip focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ws-pip">
        Open
      </button>
    </article>
  );
}

interface StripProps {
  runs: readonly Run[];
  now: number;
  workstream?: string | null;
  /** Failed runs the person dismissed, which leave the strip as they leave Needs you. */
  dismissed?: ReadonlySet<string>;
  titleOf(run: Run): string | null;
  onOpen(run: Run): void;
  /** Opens the Agents view, offered when there are more runs than the strip shows. */
  onSeeAll?(): void;
}

/**
 * Up to three live runs above the drafts: the ones that need the person (unseen failures among them), then the ones
 * working. In a workstream's conversation (`workstream`), only that workstream's runs. When it lists more such runs than
 * it shows, the header says how many of them it shows and links to the Agents view; never when nothing was cut. Absent when nothing is going.
 */
export function PipRunStripView({ runs, now, workstream = null, dismissed, titleOf, onOpen, onSeeAll }: StripProps) {
  const labels = labelsByRun(runs);
  const scope = workstream ? runs.filter((r) => r.spec.workstream === workstream) : runs;
  // Out of the runs it would list, not every run there is: one finished or seen is not left out, only not listed.
  const listed = stripRuns(scope, dismissed);
  const shown = listed.slice(0, STRIP_SHOWN);
  if (!shown.length) return null;
  const more = shown.length < listed.length;
  return (
    <section aria-label="Your agents" className="grid gap-1.5">
      <h3 className="m-0 flex items-baseline gap-1.5 text-xs font-semibold tracking-wide text-ws-ink3 uppercase">
        Your agents <span data-strip-count className="font-normal">{more ? `${shown.length} of ${listed.length}` : shown.length}</span>
        {more && onSeeAll && (
          <button type="button" onClick={onSeeAll} className="ml-auto font-semibold tracking-normal text-ws-accent normal-case hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ws-pip">
            See all in Agents
          </button>
        )}
      </h3>
      {shown.map((run) => (
        <PipRunCard key={run.id} run={run} now={now} ticketTitle={titleOf(run)} label={labels.get(run.id)} onOpen={() => onOpen(run)} />
      ))}
    </section>
  );
}

export function PipRunStrip({ workstream = null }: { workstream?: string | null }) {
  const runs = useRuns((s) => s.runs);
  const dismissed = useRuns((s) => s.dismissed);
  const items = useWorkspace((s) => s.items);
  return (
    <PipRunStripView
      runs={runs}
      now={Date.now()}
      workstream={workstream}
      dismissed={dismissed}
      onSeeAll={() => useTabs.getState().setRoute("agents")}
      titleOf={(run) => (run.item ? (items[itemKey(run.item)]?.title ?? null) : null)}
      onOpen={(run) => useRuns.getState().openRun(run.id, { stay: true })}
    />
  );
}
