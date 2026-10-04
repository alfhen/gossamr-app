import type { Run } from "../types";
import { Icon, STATE_ICON } from "./AgentIcons";
import { failureHelp, retryEnabled, type FailureAct } from "./failureHelp";
import { RunVerdictChip } from "./ManagerBadges";
import { createdFrom } from "./runSheetLogic";
import { permissionRequest, progressText, quietMinutes, quietText, resultHeadline, stateView, type Tone } from "./agentsLogic";

export const TONE: Record<Tone, { text: string; soft: string; color: string }> = {
  pip: { text: "text-ws-pip", soft: "bg-ws-pip-soft", color: "var(--color-ws-pip)" },
  accent: { text: "text-ws-accent", soft: "bg-ws-accent-soft", color: "var(--color-ws-accent)" },
  done: { text: "text-ws-done", soft: "bg-ws-done-soft", color: "var(--color-ws-done)" },
  warn: { text: "text-ws-warn", soft: "bg-ws-warn/15", color: "var(--color-ws-warn)" },
  blocked: { text: "text-ws-blocked", soft: "bg-ws-blocked-soft", color: "var(--color-ws-blocked)" },
  muted: { text: "text-ws-ink3", soft: "bg-ws-hover", color: "var(--color-ws-ink3)" },
};

export function StateChip({ run, now }: { run: Run; now: number }) {
  const v = stateView(run, now);
  const t = TONE[v.tone];
  return (
    <>
      <span data-state={run.state} className={`inline-flex items-center gap-1 rounded-full px-2 text-xs leading-[1.6] font-semibold whitespace-nowrap ${t.soft} ${t.text}`}>
        <Icon name={STATE_ICON[v.icon]} className="size-[11px]" />
        {v.label}
      </span>
      <RunVerdictChip run={run} />
    </>
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
  return (
    <div className="flex flex-wrap items-center gap-2">
      {help.primary && (
        <button type="button" onClick={(ev) => (ev.stopPropagation(), failure.on.act(help.primary!.act))} className={`${BUTTON} ${next ? "border-ws-pip bg-ws-pip font-semibold text-ws-on-pip hover:brightness-110" : "border-ws-sep2 text-ws-ink hover:bg-ws-hover"}`}>
          <Icon name={help.primary.act === "terminal" ? "term" : help.primary.act === "install" ? "ext" : "play"} />
          {help.primary.label}
        </button>
      )}
      <button
        type="button"
        disabled={!ready}
        title={ready ? undefined : RETRY_WAITS}
        onClick={(ev) => (ev.stopPropagation(), failure.on.retry())}
        className={`${BUTTON} ${ready && !next ? "border-ws-pip bg-ws-pip font-semibold text-ws-on-pip hover:brightness-110" : "border-ws-sep2 text-ws-ink hover:bg-ws-hover"}`}
      >
        <Icon name="retry" />
        Retry
      </button>
    </div>
  );
}

const clamp = (lines: 2 | 3) => (lines === 2 ? "line-clamp-2" : "line-clamp-3");

/** What a card or row says about the run's state, in the order the person needs it. */
export function RunBody({ run, now, onAttach, failure }: { run: Run; now: number; onAttach(): void; failure: FailureState }) {
  const quiet = quietMinutes(run, now);
  switch (run.state) {
    case "needsPermission": {
      const ask = permissionRequest(run.needs);
      return (
        <div className="grid gap-2 rounded-lg border border-ws-sep bg-ws-win px-2.5 py-2">
          <p className="m-0 text-ws-ink2">
            {ask ? (
              <>
                Wants to run a command{ask.tool && ask.tool !== "Bash" ? ` with ${ask.tool}` : ""}. It is waiting for you in Terminal.
              </>
            ) : (
              "It is waiting for permission in Terminal."
            )}
          </p>
          {ask && <code className="selectable block max-h-24 overflow-auto rounded-md border border-ws-sep bg-ws-bar px-2 py-1 font-mono text-sm break-words whitespace-pre-wrap text-ws-ink">{ask.command}</code>}
          <div className="flex flex-wrap items-center gap-2">
            <OpenInTerminal run={run} onOpen={onAttach} />
          </div>
        </div>
      );
    }
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
          <span className={`${clamp(2)} -mt-0.5 min-w-0`}>{run.lastDetail?.trim() || "Stopped before it finished"}</span>
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
            <span className={`${clamp(2)} -mt-0.5 min-w-0 [overflow-wrap:anywhere]`}>{progressText(run)}</span>
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

/** The single line a list row shows after the state chip. */
export function rowText(run: Run, now: number): string {
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
      return run.lastDetail?.trim() || "Stopped before it finished";
    default:
      return quiet !== null ? `${quietText(quiet)}. ${progressText(run)}` : progressText(run);
  }
}
