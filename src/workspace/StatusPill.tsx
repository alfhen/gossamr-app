import { useId, useMemo } from "react";
import { WAITING_FOR_PR } from "../lib/workstreamStage";
import { hintFor, workstreamStatus, type StatusTone, type WorkstreamStatus } from "../lib/workstreamStatus";
import type { WorkstreamView } from "../types";
import { useRuns } from "./runsStore";
import { useNeedsYou } from "./useNeeds";

/** The bead's colour by tone: indigo for what is the person's, amber for a failure, grey for what asks nothing. */
const TONE: Record<StatusTone, string> = {
  pip: "[--c:var(--color-ws-accent)]",
  warn: "[--c:var(--color-ws-warn)]",
  accent: "[--c:var(--color-ws-accent)]",
  ink: "[--c:var(--color-ws-ink3)]",
  done: "[--c:var(--color-ws-done)]",
};

/**
 * A workstream's one status word as a bead and a word (`data-status`, its state in `data-status-state`); its one short detail, if any, follows it.
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
      <span data-status={status.state} title={hint} aria-describedby={describe ? hintId : undefined} className={`ws-state shrink-0 text-xs font-medium whitespace-nowrap text-ws-ink2 ${TONE[status.tone]}`}>
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

/** Said beside the status word while a finished build's pull request hasn't been found yet; a done workstream waits for nothing. */
export function WaitingForPr({ view, status }: { view: WorkstreamView; status: Pick<WorkstreamStatus, "state"> }) {
  if (!view.waitingForPr || status.state === "done") return null;
  return (
    <span data-waiting-for-pr={view.waitingForPr} className="text-xs text-ws-ink3">
      · {WAITING_FOR_PR}
    </span>
  );
}

/** The header's pill: the word and its detail, for the workstream shown. `inline` sits it in running text. */
export function HeaderStatus({ view, inline = false }: { view: WorkstreamView; inline?: boolean }) {
  const status = useWorkstreamStatus(view);
  return (
    <span data-header-status className={`${inline ? "inline-flex" : "flex"} shrink-0 items-baseline gap-1`} title={hintFor(status)}>
      <StatusPill status={status} detail describe={false} />
      <WaitingForPr view={view} status={status} />
      <span data-status-hint className="sr-only">
        {hintFor(status)}
      </span>
    </span>
  );
}
