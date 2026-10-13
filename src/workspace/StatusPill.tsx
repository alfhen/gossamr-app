import { useMemo } from "react";
import { STATUS_HINT, workstreamStatus, type StatusTone, type WorkstreamStatus } from "../lib/workstreamStatus";
import type { WorkstreamView } from "../types";
import { useRuns } from "./runsStore";
import { useNeedsYou } from "./useNeeds";
import { useNow } from "./useNow";
import { useWorkstreamWithers } from "./useWorkstreamWithers";

/** The pill's colours, from the theme's tokens: filled for what is the person's, soft for the rest, grey for what asks nothing. */
const TONE: Record<StatusTone, string> = {
  pip: "bg-ws-pip text-ws-on-pip",
  warn: "border border-ws-warn/50 bg-ws-warn/10 text-ws-ink",
  review: "bg-ws-review-soft text-ws-review",
  accent: "bg-ws-accent-soft text-ws-accent",
  ink: "bg-ws-hover text-ws-ink2",
  done: "bg-ws-done-soft text-ws-done",
};

/** A workstream's one status word as a small pill (`data-status`, its state in `data-status-state`); its one short detail, if any, follows it. */
export function StatusPill({ status, title, detail = false }: { status: WorkstreamStatus; title?: string; detail?: boolean }) {
  return (
    <>
      <span data-status={status.state} title={title ?? STATUS_HINT[status.state]} className={`shrink-0 rounded-full px-1.5 text-[10px] leading-4 font-semibold whitespace-nowrap ${TONE[status.tone]}`}>
        {status.word}
      </span>
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
  const runs = useRuns((s) => s.runs);
  const needs = useNeedsYou();
  const now = useNow();
  const withers = useWorkstreamWithers(useMemo(() => [view], [view]), now);
  return useMemo(() => workstreamStatus(view, needs, { runs, wither: withers[view.workstream.id] ?? null, now: new Date(now) }), [view, needs, runs, withers, now]);
}

/** The header's pill: the word and its detail, for the workstream shown. */
export function HeaderStatus({ view }: { view: WorkstreamView }) {
  const status = useWorkstreamStatus(view);
  return (
    <span data-header-status className="flex shrink-0 items-baseline gap-1" title={STATUS_HINT[status.state]}>
      <StatusPill status={status} detail />
    </span>
  );
}
