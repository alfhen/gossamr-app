import { useMemo } from "react";
import type { Run } from "../types";
import { Icon, STATE_ICON } from "./AgentIcons";
import { useDecisionShown } from "./decisionShown";
import { CloneActions } from "./CloneActions";
import { failureHelp, retryEnabled, type FailureAct } from "./failureHelp";
import { createdFrom } from "./runSheetLogic";
import { useRuns } from "./runsStore";
import { useWorkstreams } from "./workstreamsStore";
import { PermissionAsk, PermissionSent, usePermissionConfirmation } from "./PermissionAsk";
import { useStateView } from "./useStateView";
import { permissionRequest, progressText, quietMinutes, quietText, resultHeadline, slotQueue, stateView, stoppedText, type Tone } from "./agentsLogic";

export const TONE: Record<Tone, { text: string; soft: string; color: string }> = {
  pip: { text: "text-ws-pip", soft: "bg-ws-pip-soft", color: "var(--color-ws-pip)" },
  accent: { text: "text-ws-accent", soft: "bg-ws-accent-soft", color: "var(--color-ws-accent)" },
  done: { text: "text-ws-done", soft: "bg-ws-done-soft", color: "var(--color-ws-done)" },
  warn: { text: "text-ws-warn", soft: "bg-ws-warn/15", color: "var(--color-ws-warn)" },
  blocked: { text: "text-ws-blocked", soft: "bg-ws-blocked-soft", color: "var(--color-ws-blocked)" },
  muted: { text: "text-ws-ink3", soft: "bg-ws-hover", color: "var(--color-ws-ink3)" },
};

export function StateChip({ run, now }: { run: Run; now: number }) {
  const v = useStateView(run, now);
  const t = TONE[v.tone];
  return (
    <span data-state={run.state} className={`inline-flex items-center gap-1 rounded-full px-2 text-xs leading-[1.6] font-semibold whitespace-nowrap ${t.soft} ${t.text}`}>
      <Icon name={STATE_ICON[v.icon]} className="size-[11px]" />
      {v.label}
    </span>
  );
}

export function Dot({ tone, live }: { tone: Tone; live: boolean }) {
  return <span aria-hidden className={`size-2 shrink-0 rounded-full bg-current ${TONE[tone].text} ${live ? "ws-pulse" : ""}`} />;
}

const BUTTON = "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-px text-sm leading-normal whitespace-nowrap disabled:cursor-not-allowed disabled:opacity-45";

/** The one way to answer anything from here: Terminal, where the person's own Claude asks. */
export function OpenInTerminal({ run, onOpen, filled = true }: { run: Run; onOpen(): void; filled?: boolean }) {
  return (
    <button
      type="button"
      disabled={!run.shortId}
      title={run.shortId ? undefined : "There is no session to open yet"}
      onClick={(ev) => (ev.stopPropagation(), onOpen())}
      className={`${BUTTON} ${filled ? "border-ws-pip bg-ws-pip font-semibold text-ws-on-pip hover:brightness-110" : "border-ws-sep2 text-ws-ink hover:bg-ws-hover"}`}
    >
      <Icon name="term" />
      Open in Terminal
    </button>
  );
}

/** What the cards and the sheet can do about a failed launch. */
export interface FailureActions {
  act(act: FailureAct): void;
  retry(): void;
  /** The person copied the command to run it in their own terminal. */
  copied(): void;
}

export interface FailureState {
  /** Terminal was opened for this run, or its command copied. */
  opened: boolean;
  on: FailureActions;
}

const RETRY_WAITS = "Do the step above first, then retry";

export function FailureNext({ run, failure }: { run: Run; failure: FailureState }) {
  const help = failureHelp(run);
  if (!help) return null;
  const ready = retryEnabled(help, failure.opened);
  const next = help.primary && !(help.retryNeedsTerminal && failure.opened);
  const why = `retry-waits-${run.id}`;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {help.kind === "noClone" && <CloneActions run={run} />}
      {help.primary && (
        <button type="button" onClick={(ev) => (ev.stopPropagation(), failure.on.act(help.primary!.act))} className={`${BUTTON} ${next ? "border-ws-pip bg-ws-pip font-semibold text-ws-on-pip hover:brightness-110" : "border-ws-sep2 text-ws-ink hover:bg-ws-hover"}`}>
          <Icon name={help.primary.act === "terminal" ? "term" : "ext"} />
          {help.primary.label}
        </button>
      )}
      <button
        type="button"
        disabled={!ready}
        aria-describedby={ready ? undefined : why}
        onClick={(ev) => (ev.stopPropagation(), failure.on.retry())}
        className={`${BUTTON} ${ready && !next ? "border-ws-pip bg-ws-pip font-semibold text-ws-on-pip hover:brightness-110" : "border-ws-sep2 text-ws-ink hover:bg-ws-hover"}`}
      >
        <Icon name="retry" />
        Retry
      </button>
      {!ready && (
        <span id={why} className="text-xs text-ws-ink2">
          {RETRY_WAITS}
        </span>
      )}
    </div>
  );
}

const clamp = (lines: 2 | 3) => (lines === 2 ? "line-clamp-2" : "line-clamp-3");

/** Every run that can be given a slot, from the live stores, so a run waiting for one is placed in the same line everywhere (`slotQueue`). */
export function useSlotQueue(): readonly Run[] {
  const runs = useRuns((s) => s.runs);
  const workstreams = useWorkstreams((s) => s.list);
  return useMemo(() => slotQueue(runs, workstreams), [runs, workstreams]);
}

/** What a card or row says about the run's state, in the order the person needs it. */
export function RunBody({ run, now, onAttach, failure }: { run: Run; now: number; onAttach(): void; failure: FailureState }) {
  const denied = usePermissionConfirmation(run);
  const body = <StateBody run={run} now={now} onAttach={onAttach} failure={failure} />;
  // A denial is confirmed on the card it was given on, which is working again by then.
  if (denied?.kind !== "denied") return body;
  return (
    <div className="grid gap-2">
      <PermissionSent answered={denied} />
      {body}
    </div>
  );
}

/** The body for the run's current state; a denial's confirmation goes above it. */
function StateBody({ run, now, onAttach, failure }: { run: Run; now: number; onAttach(): void; failure: FailureState }) {
  const runs = useSlotQueue();
  const quiet = quietMinutes(run, now);
  const shown = useDecisionShown();
  switch (run.state) {
    case "needsPermission":
      // Asked once: the open workstream's Needs you holds the buttons, so the card does not repeat them (nor take the keyboard when they are pressed).
      if (shown.need?.runId === run.id && shown.need.kind === "permission") return <p className="m-0 text-ws-ink2">Asking you in Needs you, in the open workstream.</p>;
      return (
        <div className="grid gap-2 rounded-lg border border-ws-sep bg-ws-win px-2.5 py-2">
          <PermissionAsk run={run} onAttach={onAttach} onStop={() => void useRuns.getState().stop(run.id)} confirmStop />
        </div>
      );
    case "needsAnswer":
      return (
        <div className="grid gap-2 rounded-lg border border-ws-sep bg-ws-win px-2.5 py-2">
          <q className={`${clamp(3)} [quotes:none] text-ws-ink`}>{run.needs?.trim() || "It is waiting for you"}</q>
          <div className="flex flex-wrap items-center gap-2">
            <OpenInTerminal run={run} onOpen={onAttach} />
          </div>
        </div>
      );
    case "systemBlocked":
      return (
        <div className="grid gap-2 rounded-lg border border-ws-sep bg-ws-win px-2.5 py-2">
          <p className="m-0 font-semibold text-ws-ink">Claude needs you to sign in</p>
          <div className="flex flex-wrap items-center gap-2">
            <OpenInTerminal run={run} onOpen={onAttach} />
          </div>
        </div>
      );
    case "unknown":
      return (
        <div className="grid gap-2">
          <p className="m-0 text-ws-ink2">{run.needs?.trim() || run.lastDetail?.trim() || "Open in Terminal to look"}</p>
          <div className="flex flex-wrap items-center gap-2">
            <OpenInTerminal run={run} onOpen={onAttach} filled={false} />
          </div>
        </div>
      );
    case "failed": {
      const help = failureHelp(run);
      return (
        <div className="grid gap-2">
          <p className="m-0 flex items-start gap-1.5 text-ws-blocked">
            <Icon name="alert" className="mt-0.5 size-3.5" />
            <span className={`${clamp(3)} min-w-0 [overflow-wrap:anywhere]`}>{help?.summary ?? (run.error?.trim() || "It didn't start")}</span>
          </p>
          {help && <FailureNext run={run} failure={failure} />}
        </div>
      );
    }
    case "done":
      return (
        <p className="m-0 flex items-start gap-2 text-ws-ink2">
          <Dot tone="done" live={false} />
          <span className={`${clamp(2)} -mt-0.5 min-w-0 [overflow-wrap:anywhere]`}>{createdFrom(run) ?? resultHeadline(run.summary ?? run.result) ?? "Finished"}</span>
        </p>
      );
    case "stopped":
      return (
        <p className="m-0 flex items-start gap-2 text-ws-ink3">
          <Dot tone="muted" live={false} />
          <span className={`${clamp(2)} -mt-0.5 min-w-0`}>{stoppedText(run)}</span>
        </p>
      );
    default: {
      const v = stateView(run, now);
      return (
        <div className="grid gap-2">
          {quiet !== null && (
            <p className="m-0 flex items-center gap-1.5 font-semibold text-ws-warn">
              <Icon name="clock" className="size-3.5" />
              {quietText(quiet)}
            </p>
          )}
          <p className="m-0 flex items-start gap-2 text-ws-ink2">
            <Dot tone={v.tone} live={v.live} />
            <span data-slot-wait={run.slotWaitSince ? "" : undefined} className={`${clamp(2)} -mt-0.5 min-w-0 [overflow-wrap:anywhere]`}>
              {progressText(run, runs)}
            </span>
          </p>
          {quiet !== null && (
            <div className="flex flex-wrap items-center gap-2">
              <OpenInTerminal run={run} onOpen={onAttach} filled={false} />
            </div>
          )}
        </div>
      );
    }
  }
}

/** `rowText` as an element, placing a run waiting for a slot in line among every run (`useSlotQueue`). */
export function RowText({ run, now }: { run: Run; now: number }) {
  return <>{rowText(run, now, useSlotQueue())}</>;
}

/** The single line a list row shows after the state chip; `runs` places a run waiting for a slot in line. */
export function rowText(run: Run, now: number, runs?: readonly Run[]): string {
  const quiet = quietMinutes(run, now);
  switch (run.state) {
    case "needsPermission":
      return permissionRequest(run.needs)?.command ?? "Waiting for permission";
    case "needsAnswer":
      return run.needs?.trim() || "It is waiting for you";
    case "systemBlocked":
      return "Claude needs you to sign in";
    case "unknown":
      return "Open in Terminal to look";
    case "failed":
      return failureHelp(run)?.summary ?? (run.error?.trim() || "It didn't start");
    case "done":
      return createdFrom(run) ?? resultHeadline(run.summary ?? run.result) ?? "Finished";
    case "stopped":
      return stoppedText(run);
    default:
      return quiet !== null ? `${quietText(quiet)}. ${progressText(run, runs)}` : progressText(run, runs);
  }
}
