import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useBackend } from "../backend/useBackend";
import { itemKey } from "../lib/filter";
import type { Run, RunEvent, RunReview } from "../types";
import { useWorkspace } from "../workspaceStore";
import { Icon, KIND_ICON } from "./AgentIcons";
import { Box, BoxTitle, Btn, CodeBox, CopyButton, Details, MONO_BLOCK, Sec, SheetFrame } from "./AgentSheet";
import { StateChip } from "./AgentParts";
import { KIND_LABEL, ageText, formatTokens, groupRuns, navOrder, permissionRequest, progressText, quietMinutes, quietText, repoName, runTitle, stateView } from "./agentsLogic";
import { openTicketByKey } from "./jump";
import { failureHelp, retryEnabled, type FailureAct } from "./failureHelp";
import { failureAction } from "./failureActions";
import { PromptParts } from "./RunPrompt";
import { RunTimeline } from "./RunTimeline";
import { RunWhere, useDisk } from "./RunWhere";
import { MAY_TOUCH, canStartNow, stopControl } from "./runSheetLogic";
import { useRuns } from "./runsStore";

export interface RunSheetActions {
  close(): void;
  attach(): void;
  askStop(): void;
  cancelStop(): void;
  stop(): void;
  startNow(): void;
  retry(): void;
  fix(act: FailureAct): void;
  copied(): void;
  openTicket(): void;
  reveal(path: string): void;
  loadBrief(): void;
}

export interface RunSheetViewProps {
  run: Run;
  now: number;
  ticketTitle: string | null;
  /** Where the run is among those j and k walk through. */
  place: { index: number; total: number } | null;
  wide: boolean;
  onWide(): void;
  events: readonly RunEvent[] | null;
  disk: number | null | "unknown";
  brief: RunReview | "loading" | "unavailable" | null;
  confirmStop: boolean;
  /** Terminal was opened for this failed run, or its command copied. */
  opened: boolean;
  on: RunSheetActions;
}

function OpenInTerminal({ run, on, filled = true }: { run: Run; on: RunSheetActions; filled?: boolean }) {
  return (
    <Btn tone={filled ? "primary" : "plain"} icon="term" disabled={!run.shortId} title={run.shortId ? undefined : "There is no session to open yet"} onClick={on.attach}>
      Open in Terminal
    </Btn>
  );
}

function Attention({ run, opened, on }: { run: Run; opened: boolean; on: RunSheetActions }) {
  switch (run.state) {
    case "needsPermission": {
      const ask = permissionRequest(run.needs);
      return (
        <Box tone="needs" label="Permission request">
          <BoxTitle icon="hand" tone="needs">
            Claude is asking permission
          </BoxTitle>
          <p className="m-0 text-ws-ink">{ask ? `It wants to run ${ask.tool && ask.tool !== "Bash" ? `a ${ask.tool} command` : "this command"}:` : "It is waiting for permission."}</p>
          {ask && <CodeBox text={ask.command} what="the command" wrap />}
          <p className="m-0 text-sm text-ws-ink2">The session is waiting in Terminal. Gossamr can&apos;t answer for you: open it there and choose. Gossamr adds no rules of its own on top of yours.</p>
          <div>
            <OpenInTerminal run={run} on={on} />
          </div>
        </Box>
      );
    }
    case "needsAnswer":
      return (
        <Box tone="needs" label="Question from the agent">
          <BoxTitle icon="hand" tone="needs">
            Claude is asking you
          </BoxTitle>
          <q className="selectable block border-l-[3px] border-ws-sep2 py-0.5 pl-3 whitespace-pre-wrap text-ws-ink [quotes:none]">{run.needs?.trim() || "It is waiting for you"}</q>
          <p className="m-0 text-sm text-ws-ink2">Answer in Terminal, in the session itself. Gossamr can&apos;t send an answer for you.</p>
          <div>
            <OpenInTerminal run={run} on={on} />
          </div>
        </Box>
      );
    case "systemBlocked":
      return (
        <Box tone="needs" label="Sign-in needed">
          <BoxTitle icon="lock" tone="needs">
            Claude needs you to sign in
          </BoxTitle>
          <p className="m-0 text-sm text-ws-ink2">Sign in in Terminal. The run carries on once Claude is signed in again.</p>
          <div>
            <OpenInTerminal run={run} on={on} />
          </div>
        </Box>
      );
    case "unknown":
      return (
        <Box tone="warn" label="State unclear">
          <BoxTitle icon="help" tone="warn">
            Open in Terminal to look
          </BoxTitle>
          <p className="m-0 text-ws-ink2">{run.needs?.trim() || run.lastDetail?.trim() || "Gossamr can't tell what this session is doing."}</p>
          <div>
            <OpenInTerminal run={run} on={on} filled={false} />
          </div>
        </Box>
      );
    case "failed":
      return <FailureBox run={run} opened={opened} on={on} />;
    case "queued":
      return (
        <Box tone="plain" label="Waiting to start">
          <BoxTitle icon="clock" tone="plain">
            Waiting to start
          </BoxTitle>
          <p className="m-0 text-ws-ink2">It is approved but has not been launched, as after a restart. Nothing runs until you start it.</p>
        </Box>
      );
    default:
      return null;
  }
}

function FailureBox({ run, opened, on }: { run: Run; opened: boolean; on: RunSheetActions }) {
  const help = failureHelp(run);
  const message = run.error?.trim() || "No reason was recorded.";
  const ready = help ? retryEnabled(help, opened) : true;
  const stepDone = !!help?.primary && help.retryNeedsTerminal && opened;
  return (
    <Box tone="failed" label="Failure">
      <BoxTitle icon="alert" tone="failed">
        {run.shortId ? "The run stopped without finishing" : "It didn't start"}
      </BoxTitle>
      {help ? (
        <>
          <p className="m-0 font-semibold text-ws-ink">{help.summary}</p>
          <p className="m-0 text-ws-ink2">{help.detail}</p>
          <div className="flex flex-wrap items-center gap-2">
            {help.primary && (
              <Btn tone={stepDone ? "plain" : "primary"} icon={help.primary.act === "terminal" ? "term" : help.primary.act === "install" ? "ext" : "play"} onClick={() => on.fix(help.primary!.act)}>
                {help.primary.label}
              </Btn>
            )}
            <Btn tone={stepDone || !help.primary ? "primary" : "plain"} icon="retry" disabled={!ready} title={ready ? undefined : "Do the step above first, then retry"} onClick={on.retry}>
              Retry
            </Btn>
          </div>
          {help.command && (
            <div className="grid gap-1">
              <span className="text-xs text-ws-ink3">Or run this in your own terminal{help.command.note ? `. ${help.command.note}` : ":"}</span>
              <CodeBox text={help.command.text} what="the command" wrap onCopied={on.copied} />
            </div>
          )}
          <p className="m-0 text-xs text-ws-ink3">Retry looks for a session that already exists first, and only then starts one. Same prompt, nothing to approve again.</p>
          <Details summary="What Gossamr recorded">
            <pre className="selectable m-0 font-mono text-sm leading-normal break-words whitespace-pre-wrap text-ws-ink2">{message}</pre>
          </Details>
        </>
      ) : (
        <>
          <pre className="selectable m-0 font-mono text-sm leading-normal break-words whitespace-pre-wrap text-ws-ink2">{message}</pre>
          {!run.shortId && (
            <div className="grid gap-1.5">
              <div>
                <Btn tone="primary" icon="retry" onClick={on.retry}>
                  Retry launch
                </Btn>
              </div>
              <p className="m-0 text-xs text-ws-ink3">Looks for a session that already exists first, and only then starts one. Same prompt, nothing to approve again.</p>
            </div>
          )}
        </>
      )}
    </Box>
  );
}

function Facts({ run, now, ticketTitle, on }: { run: Run; now: number; ticketTitle: string | null; on: RunSheetActions }) {
  const quiet = quietMinutes(run, now);
  const tokens = formatTokens(run.tokens);
  const ended = !!run.endedAt;
  return (
    <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1.5 text-ws-ink2">
      <StateChip run={run} now={now} />
      {quiet !== null && (
        <span className="inline-flex items-center gap-1 rounded-full bg-ws-warn/15 px-2 text-xs leading-[1.6] font-semibold text-ws-warn" title="No new line and no new tokens for a while. It may be waiting on something slow.">
          <Icon name="clock" className="size-[11px]" />
          {quietText(quiet)}
        </span>
      )}
      <span>
        {ended ? "Finished" : "Started"} <b className="font-semibold text-ws-ink">{ageText(run, now)}</b>
      </span>
      {tokens && <span>{tokens}</span>}
      {run.item && (
        <span>
          Ticket{" "}
          <button type="button" onClick={on.openTicket} title={ticketTitle ?? undefined} className="font-mono font-semibold text-ws-accent hover:underline">
            {run.item.key}
          </button>
        </span>
      )}
    </div>
  );
}

function Result({ run }: { run: Run }) {
  const text = run.result?.trim();
  return (
    <Sec title="What it found">
      <Box>
        {text ? <p className="selectable m-0 whitespace-pre-wrap text-[13.5px] [overflow-wrap:anywhere]">{text}</p> : <p className="m-0 text-ws-ink3">It finished without a written answer.</p>}
        <div className="flex flex-wrap items-center gap-2">
          {text && <CopyButton text={text} label="Copy" what="the result" />}
          <span className="text-xs text-ws-ink3">Anything for Jira is yours to post. Nothing was sent.</span>
        </div>
      </Box>
    </Sec>
  );
}

function BriefBody({ brief }: { brief: RunSheetViewProps["brief"] }): ReactNode {
  if (brief === null || brief === "loading") return <p className="m-0 text-ws-ink3">Loading…</p>;
  if (brief === "unavailable") return <p className="m-0 text-ws-ink3">The brief couldn&apos;t be read.</p>;
  return (
    <>
      <PromptParts review={brief} />
      <Details summary="What Gossamr added for the model">
        <pre className={MONO_BLOCK}>{brief.guard}</pre>
      </Details>
    </>
  );
}

/** The whole sheet as a function of what it is shown; `RunSheet` loads the data and connects the actions. */
export function RunSheetView({ run, now, ticketTitle, place, wide, onWide, events, disk, brief, confirmStop, opened, on }: RunSheetViewProps) {
  const view = stateView(run, now);
  const stop = stopControl(run);
  const title = runTitle(run, ticketTitle);
  const attention = ["needsPermission", "needsAnswer", "systemBlocked", "unknown", "failed", "queued"].includes(run.state);
  const live = run.state === "working" ? progressText(run) : null;
  return (
    <SheetFrame
      label="Agent run"
      title={run.item?.key ?? "Agent"}
      hint={
        <>
          agent run · <kbd className="font-sans">j</kbd> <kbd className="font-sans">k</kbd> browse · <kbd className="font-sans">esc</kbd> close{place ? ` · ${place.index} of ${place.total}` : ""}
        </>
      }
      wide={wide}
      onWide={onWide}
      onClose={on.close}
    >
      <div data-state={run.state} data-tone={view.tone} className="grid gap-2.5">
        <div className="flex items-center gap-1.5 text-xs font-medium text-ws-ink2">
          <Icon name={KIND_ICON[run.spec.kind]} className="size-[13px] text-ws-ink3" />
          {KIND_LABEL[run.spec.kind]}
          <span aria-hidden className="text-ws-ink3">
            ·
          </span>
          <span className="font-mono">{repoName(run.spec.repo)}</span>
        </div>
        <h2 className="m-0 text-[20px] leading-tight font-semibold [overflow-wrap:anywhere]">{title}</h2>
        <Facts run={run} now={now} ticketTitle={ticketTitle} on={on} />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {!attention && <OpenInTerminal run={run} on={on} filled={run.state === "working"} />}
        {run.item && (
          <Btn icon="ext" onClick={on.openTicket}>
            Open ticket
          </Btn>
        )}
        <span className="flex-1" />
        {canStartNow(run) && (
          <Btn tone="primary" icon="play" onClick={on.startNow}>
            Start now
          </Btn>
        )}
        {stop.shown &&
          (confirmStop ? (
            <span
              role="group"
              aria-label="Stop this agent"
              data-esc-local
              className="inline-flex flex-wrap items-center gap-1.5"
              onKeyDown={(ev) => {
                if (ev.key === "Escape") (ev.stopPropagation(), on.cancelStop());
              }}
            >
              <span className="text-ws-ink2">Stop this agent? Its work is kept.</span>
              <Btn tone="dangerFill" autoFocus onClick={on.stop}>
                Yes, stop
              </Btn>
              <Btn tone="ghost" onClick={on.cancelStop}>
                Keep going
              </Btn>
            </span>
          ) : (
            <Btn tone="danger" icon="stop" disabled={!stop.enabled} title={stop.title} onClick={on.askStop}>
              {stop.label}
            </Btn>
          ))}
      </div>

      {attention && <Attention run={run} opened={opened} on={on} />}
      {run.state === "done" && <Result run={run} />}

      <Sec title="What it did" count={events ? `${events.length} ${events.length === 1 ? "entry" : "entries"}` : undefined}>
        <RunTimeline events={events} live={live} />
      </Sec>

      <RunWhere run={run} disk={disk} onReveal={on.reveal} />

      <Sec title="What this agent may touch">
        <ul className="m-0 grid list-none gap-1.5 p-0 text-ws-ink2">
          {MAY_TOUCH.map((t) => (
            <li key={t.title} data-tone={t.tone} className="grid grid-cols-[18px_minmax(0,1fr)] gap-1.5">
              <Icon name={t.tone === "yes" ? "check" : t.tone === "ask" ? "hand" : "x"} className={`mt-0.5 size-3.5 ${t.tone === "yes" ? "text-ws-done" : t.tone === "ask" ? "text-ws-warn" : "text-ws-ink3"}`} />
              <span>
                <b className="font-semibold text-ws-ink">{t.title}</b> {t.text}
              </span>
            </li>
          ))}
        </ul>
      </Sec>

      <Details summary="The brief as it was sent" onToggle={(open) => open && on.loadBrief()}>
        <BriefBody brief={brief} />
        <p className="m-0 text-xs text-ws-ink3 [overflow-wrap:anywhere]">What you approved: {run.digest.slice(0, 16)}</p>
      </Details>
    </SheetFrame>
  );
}

/** The run sheet for the run `useRuns().sheet` points at, with its timeline, disk size and brief read when it opens. */
export function RunSheet({ id }: { id: string }) {
  const backend = useBackend();
  const run = useRuns((s) => s.runs.find((r) => r.id === id));
  const runs = useRuns((s) => s.runs);
  const filters = useRuns((s) => s.filters);
  const earlierOpen = useRuns((s) => s.earlierOpen);
  const ticket = useWorkspace((s) => (run?.item ? s.items[itemKey(run.item)] : undefined));
  const [wide, setWide] = useState(false);
  const [events, setEvents] = useState<RunEvent[] | null>(null);
  const [brief, setBrief] = useState<RunSheetViewProps["brief"]>(null);
  const [confirmStop, setConfirmStop] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const disk = useDisk(backend, id);
  const opened = useRuns((s) => s.terminalOpened.has(id));

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    setConfirmStop(false);
    setBrief(null);
    setEvents(null);
  }, [id]);

  const progress = run ? `${run.state}:${run.lastProgressAt}:${run.lastDetail ?? ""}` : "";
  useEffect(() => {
    let live = true;
    backend?.runsEvents(id).then(
      (list) => live && setEvents(list),
      () => live && setEvents([]),
    );
    return () => {
      live = false;
    };
  }, [backend, id, progress]);

  const place = useMemo(() => {
    const order = navOrder(groupRuns(runs, filters, now), earlierOpen, filters);
    const at = order.indexOf(id);
    return at < 0 ? null : { index: at + 1, total: order.length };
  }, [runs, filters, earlierOpen, id, now]);

  if (!run) return null;
  const store = useRuns.getState();
  const on: RunSheetActions = {
    close: () => store.closeSheet(),
    attach: () => void store.attach(id),
    askStop: () => setConfirmStop(true),
    cancelStop: () => setConfirmStop(false),
    stop: () => (setConfirmStop(false), void store.stop(id)),
    startNow: () => void store.startNow(id),
    retry: () => void store.retryLaunch(id),
    fix: (act) => failureAction(id, act),
    copied: () => store.noteCopied(id),
    openTicket: () => {
      if (!run.item) return;
      store.closeSheet();
      void openTicketByKey(run.item.key);
    },
    reveal: (path) => void backend?.revealPath(path).catch(() => {}),
    loadBrief: () => {
      if (brief !== null || !backend) return;
      setBrief("loading");
      backend.runsReview(run.proposalId).then(setBrief, () => setBrief("unavailable"));
    },
  };
  return <RunSheetView run={run} now={now} ticketTitle={ticket?.title ?? null} place={place} wide={wide} onWide={() => setWide((w) => !w)} events={events} disk={disk} brief={brief} confirmStop={confirmStop} opened={opened} on={on} />;
}

