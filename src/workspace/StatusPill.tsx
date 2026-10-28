import { useId, useMemo } from "react";
import { WAITING_FOR_PR } from "../lib/workstreamStage";
import { hintFor, workstreamStatus, type StatusTone, type WorkstreamStatus } from "../lib/workstreamStatus";
import type { WorkstreamView } from "../types";
import { useRuns } from "./runsStore";
import { useNeedsYou } from "./useNeeds";

/** The pill's colours, from the theme's tokens: filled for what is the person's, soft for the rest, grey for what asks nothing. */
const TONE: Record<StatusTone, string> = {
  pip: "bg-ws-pip text-ws-on-pip",
  warn: "border border-ws-warn/50 bg-ws-warn/10 text-ws-ink",
  accent: "bg-ws-accent-soft text-ws-accent",
  ink: "bg-ws-hover text-ws-ink2",
  done: "bg-ws-done-soft text-ws-done",
};

/**
 * A workstream's one status word as a small pill (`data-status`, its state in `data-status-state`); its one short detail, if any, follows it.
 * The hint is the mouse's `title` and, for everyone else, a visually hidden line beside the pill that the pill is described by: it is
 * not a tab stop (the rows are walked with F6, j and k), so the row's own text carries it. `describe` is false
 * where the caller says the hint itself; `hintId` names the hint's line for a row that is described by it.
 */
export function StatusPill({ status, title, detail = false, describe = true, hintId: given }: { status: WorkstreamStatus; title?: string; detail?: boolean; describe?: boolean; hintId?: string }) {
  const own = useId();
  const hintId = given ?? own;
  const hint = title ?? hintFor(status);
  return (
    <>
      <span data-status={status.state} title={hint} aria-describedby={describe ? hintId : undefined} className={`shrink-0 rounded-full px-1.5 text-[10px] leading-4 font-semibold whitespace-nowrap ${TONE[status.tone]}`}>
        {status.word}
      </span>
      {describe && (
        <span id={hintId} data-status-hint className="sr-only">
          {hint}
        </span>
      )}
      {detail && status.detail && (
        <span data-status-detail className="min-w-0 truncate text-xs text-ws-ink3">
          · {status.detail}
        </span>
      )}
    </>
  );
}

/** The status of `view` from the stores, for where only the workstream is at hand (the header). */
export function useWorkstreamStatus(view: WorkstreamView): WorkstreamStatus {
  const active = useRuns((s) => s.runs);
  const archived = useRuns((s) => s.archived);
  const runs = useMemo(() => [...active, ...archived], [active, archived]);
  const dismissed = useRuns((s) => s.dismissed);
  const needs = useNeedsYou();
  return useMemo(() => workstreamStatus(view, needs, { runs, dismissed }), [view, needs, runs, dismissed]);
}

/** Said beside the status word while a finished build's pull request hasn't been found yet. */
export function WaitingForPr({ view }: { view: WorkstreamView }) {
  if (!view.waitingForPr) return null;
  return (
    <span data-waiting-for-pr={view.waitingForPr} className="text-xs text-ws-ink3">
      · {WAITING_FOR_PR}
    </span>
  );
}

/** The header's pill: the word and its detail, for the workstream shown. */
export function HeaderStatus({ view }: { view: WorkstreamView }) {
  const status = useWorkstreamStatus(view);
  return (
    <span data-header-status className="flex shrink-0 items-baseline gap-1" title={hintFor(status)}>
      <StatusPill status={status} detail describe={false} />
      <WaitingForPr view={view} />
      <span data-status-hint className="sr-only">
        {hintFor(status)}
      </span>
    </span>
  );
}
