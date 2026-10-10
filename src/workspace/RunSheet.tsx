import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useBackend } from "../backend/useBackend";
import { itemKey } from "../lib/filter";
import type { Run, RunEvent, RunOutcome, RunReview } from "../types";
import { useWorkspace } from "../workspaceStore";
import { Icon, KIND_ICON } from "./AgentIcons";
import { Box, BoxTitle, Btn, CodeBox, Details, MONO_BLOCK, Sec, SheetFrame } from "./AgentSheet";
import { StateChip, useSlotQueue } from "./AgentParts";
import { KIND_LABEL, agentGroups, ageText, formatTokens, ordinal, permissionRequest, progressText, quietMinutes, quietText, repoName, runTitle, slotPosition, stateView } from "./agentsLogic";
import { openTicketByKey } from "./jump";
import { failureHelp, retryEnabled, type FailureAct } from "./failureHelp";
import { failureAction } from "./failureActions";
import { PromptParts, ReadOnlyExtras, ReadOnlyLine, ReportExtras } from "./RunPrompt";
import { RunTimeline } from "./RunTimeline";
import { RunWhere, useDisk } from "./RunWhere";
import { RunCleanup } from "./RunCleanup";
import { cleanupReason } from "./cleanupLogic";
import { COPY, answerable, mayTouch, readOnlyNote, breakdownWithPipPrompt, planDescriptionWithPipPrompt, buildFromPlanOptions, canStartNow, descriptionWithPipPrompt, reviewThisControl, reviewThisOptions, commentWithPipPrompt, finishWithPipPrompt, pendingBreakdownOn, stopControl } from "./runSheetLogic";
import { showDraft } from "./draftTicket";
import { RunAnswer } from "./RunAnswer";
import { RunContinuation } from "./RunContinuation";
import { Changes, Found, type ResultActions } from "./RunResult";
import { openOnGithub } from "./githubUi";
import { askPip } from "./askPip";
import { followOutcome } from "./followOutcome";
import { useRuns } from "./runsStore";
import { useRunSetup } from "./runSetupStore";
import { usePrefs } from "./prefs";
import { useWorkstreams } from "./workstreamsStore";
import { labelsByRun } from "../lib/workstreamStage";
import { AutoStarted, RunLabel, RunRef } from "./AgentCard";

export interface RunSheetActions extends ResultActions {
  close(): void;
  attach(): void;
  askStop(): void;
  cancelStop(): void;
  stop(): void;
  startNow(): void;
  answer(text: string): void;
  adoptSession(session: string): Promise<void>;
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
  /** The run's short name in its workstream (`R1`), when it is in one. */
  label?: string;
  wide: boolean;
  onWide(): void;
  events: readonly RunEvent[] | null;
  disk: number | null | "unknown";
  brief: RunReview | "loading" | "unavailable" | null;
  confirmStop: boolean;
  outcome: RunOutcome | null;
  /** Cached tickets the blocker picker searches. */
  tickets: readonly { key: string; title: string }[];
  pickBlocker: boolean;
  /** A breakdown is waiting on the run's ticket that no run made. */
  waitingBreakdown?: boolean;
  drafting: boolean;
  /** Its answer is on its way to the agent. */
  answering: boolean;
  /** Terminal was opened for this failed run, or its command copied. */
  opened: boolean;
  /** Why this run is worth cleaning up, when it is. */
  cleanup?: string | null;
  /** Where the run is in line for a slot, 1 for next, when it waits for one. */
  slotPlace?: number | null;
  on: RunSheetActions;
}

function OpenInTerminal({ run, on, filled = true }: { run: Run; on: RunSheetActions; filled?: boolean }) {
  return (
    <Btn tone={filled ? "primary" : "plain"} icon="term" disabled={!run.shortId} title={run.shortId ? undefined : "There is no session to open yet"} onClick={on.attach}>
      Open in Terminal
    </Btn>
  );
}

function Attention({ run, opened, answering, slotPlace, on }: { run: Run; opened: boolean; answering: boolean; slotPlace: number | null; on: RunSheetActions }) {
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
    case "stopped":
      return <RunAnswer key={run.id} run={run} answering={answering} on={on} />;
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
          <p className="m-0 text-ws-ink2">{waitingText(run, slotPlace)}</p>
        </Box>
      );
    default:
      return null;
  }
}

/**
 * Why a queued run waits. One the person approved over the cap starts on its own when a slot frees, `place` in line. One
 * in a workstream starts on its own once the workstream isn't held and a slot is free (one a rule started, only while the
 * workstream is still in Manage with that rule on); any other waits for the person.
 */
export function waitingText(run: Run, place: number | null = null): string {
  if (run.slotWaitSince && !run.spec.workstream) return `It is approved and starts on its own when one of the running agents finishes${place ? ` (${ordinal(place)} in line)` : ""}. Stop it if you no longer want it.`;
  if (run.autoStart) return "A rule started it, and it launches on its own once a slot is free, while the workstream is in Manage, not held and has that step on. Until then it waits.";
  if (run.spec.workstream) return "It is approved and launches on its own once a slot is free and its workstream isn't held. Until then it waits.";
  return "It is approved but has not been launched, as after a restart. Nothing runs until you start it.";
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
        {run.state === "stopped" ? "Stopped" : ended ? "Finished" : "Started"} <b className="font-semibold text-ws-ink">{ageText(run, now)}</b>
      </span>
      {tokens && <span>{tokens}</span>}
      {(run.passes ?? 1) > 1 && (
        <span data-passes title="How many times the agent has been given this job">
          Pass <b className="font-semibold text-ws-ink">{run.passes}</b>
        </span>
      )}
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

/** The brief and what Gossamr added; the read-only rules are the ones the run was launched with, so a run from before they existed shows none. */
function BriefBody({ brief, readOnly }: { brief: RunSheetViewProps["brief"]; readOnly?: Run["readOnly"] }): ReactNode {
  if (brief === null || brief === "loading") return <p className="m-0 text-ws-ink3">Loading…</p>;
  if (brief === "unavailable") return <p className="m-0 text-ws-ink3">The brief couldn&apos;t be read.</p>;
  return (
    <>
      <PromptParts review={brief} />
      <Details summary="What Gossamr added for the model">
        <pre className={MONO_BLOCK}>{brief.guard}</pre>
        <ReadOnlyExtras readOnly={readOnly} />
        <ReportExtras report={brief.report} />
      </Details>
    </>
  );
}

/** The whole sheet as a function of what it is shown; `RunSheet` loads the data and connects the actions. */
export function RunSheetView({ run, now, ticketTitle, place, label, wide, onWide, events, disk, brief, confirmStop, outcome, tickets, pickBlocker, waitingBreakdown, drafting, answering, opened, cleanup = null, slotPlace = null, on }: RunSheetViewProps) {
  const view = stateView(run, now);
  const stop = stopControl(run);
  const title = runTitle(run, ticketTitle);
  const attention = ["needsPermission", "needsAnswer", "systemBlocked", "unknown", "failed", "queued"].includes(run.state) || answerable(run);
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
          <RunLabel label={label} />
          <Icon name={KIND_ICON[run.spec.kind]} className="size-[13px] text-ws-ink3" />
          {KIND_LABEL[run.spec.kind]}
          <span aria-hidden className="text-ws-ink3">
            ·
          </span>
          <span className="font-mono">{repoName(run.spec.repo)}</span>
          <span aria-hidden className="text-ws-ink3">
            ·
          </span>
          <RunRef run={run} />
        </div>
        <h2 className="m-0 text-[20px] leading-tight font-semibold [overflow-wrap:anywhere]">{title}</h2>
        <AutoStarted run={run} className="text-sm" />
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

      <RunContinuation key={run.id} run={run} adopt={on.adoptSession} />
      {attention && <Attention run={run} opened={opened} answering={answering} slotPlace={slotPlace} on={on} />}
      {run.state === "done" && <Found run={run} outcome={outcome} tickets={tickets} pickBlocker={pickBlocker} waitingBreakdown={waitingBreakdown} drafting={drafting} on={on} />}
      {outcome?.change && <Changes change={outcome.change} on={on} />}

      <Sec title="What it did" count={events ? `${events.length} ${events.length === 1 ? "entry" : "entries"}` : undefined}>
        <RunTimeline events={events} live={live} />
      </Sec>

      <RunWhere run={run} disk={disk} onReveal={on.reveal} />
      <RunCleanup key={run.id} run={run} reason={cleanup} />

      <Sec title="What this agent may touch">
        {run.readOnly && (
          <>
            <ReadOnlyLine readOnly={run.readOnly} />
            <p className="m-0 text-ws-ink2">{readOnlyNote(run.readOnly)}</p>
          </>
        )}
        <ul className="m-0 grid list-none gap-1.5 p-0 text-ws-ink2">
          {mayTouch(run.readOnly).map((t) => (
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
        <BriefBody brief={brief} readOnly={run.readOnly} />
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
  const group = usePrefs((s) => s.agentsGroup);
  const workstreams = useWorkstreams((s) => s.list);
  const slotLine = useSlotQueue();
  const label = useMemo(() => labelsByRun(runs).get(id), [runs, id]);
  const ticket = useWorkspace((s) => (run?.item ? s.items[itemKey(run.item)] : undefined));
  const [wide, setWide] = useState(false);
  const [events, setEvents] = useState<RunEvent[] | null>(null);
  const [brief, setBrief] = useState<RunSheetViewProps["brief"]>(null);
  const [confirmStop, setConfirmStop] = useState(false);
  const [outcome, setOutcome] = useState<RunOutcome | null>(null);
  const [pickBlocker, setPickBlocker] = useState(false);
  const items = useWorkspace((s) => s.items);
  const waitingOn = useWorkspace((s) => pendingBreakdownOn(s.proposals, run?.item ?? null)?.id ?? null);
  const drafting = useRuns((s) => s.drafting !== null);
  const answering = useRuns((s) => s.answering.has(id));
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
    setOutcome(null);
    setPickBlocker(false);
  }, [id]);

  const finished = run?.state === "done" || !!run?.branch;
  const ticketRef = run?.item ?? null;
  useEffect(() => {
    if (!backend || !finished) return;
    const stop = followOutcome(backend, id, setOutcome);
    // The pull request may not have been seen by a sync yet; asking GitHub about the ticket caches it, as the ticket peek does.
    if (ticketRef) void backend.devLinksLive(ticketRef).catch(() => {});
    return stop;
  }, [backend, id, finished, ticketRef?.externalId]);

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
    const order = agentGroups(group, runs, workstreams, filters, earlierOpen, now).order;
    const at = order.indexOf(id);
    return at < 0 ? null : { index: at + 1, total: order.length };
  }, [group, runs, workstreams, filters, earlierOpen, id, now]);

  const tickets = useMemo(() => Object.values(items).map((i) => ({ key: i.item.key, title: i.title })), [items]);
  if (!run) return null;
  const store = useRuns.getState();
  const on: RunSheetActions = {
    close: () => store.closeSheet(),
    attach: () => void store.attach(id),
    askStop: () => setConfirmStop(true),
    cancelStop: () => setConfirmStop(false),
    stop: () => (setConfirmStop(false), void store.stop(id)),
    startNow: () => void store.startNow(id),
    answer: (text) => void store.answer(id, text),
    adoptSession: (session) => store.adoptSession(id, session),
    retry: () => void store.retryLaunch(id),
    fix: (act) => failureAction(id, act),
    copied: () => store.noteCopied(id),
    openTicket: () => {
      if (!run.item) return;
      store.closeSheet();
      void openTicketByKey(run.item.key);
    },
    reveal: (path) => void backend?.revealPath(path).catch(() => {}),
    draftComment: () => void store.draftComment(id),
    askPip: () => (askPip(commentWithPipPrompt(run, outcome?.draft?.state.type === "pending" ? outcome.draft.id : null)), store.closeSheet()),
    openDraft: () => store.showDraft(run.item),
    pickBlocker: () => setPickBlocker(true),
    cancelBlocker: () => setPickBlocker(false),
    draftBlocker: (key) => void store.draftBlocker(id, key),
    draftTicket: () => void store.draftTicket(id),
    buildFromPlan: () => {
      store.closeSheet();
      void useRunSetup.getState().begin(buildFromPlanOptions(run));
    },
    reviewThis: () => {
      const change = outcome?.change;
      if (!change || !reviewThisControl(run, change).enabled) return;
      store.closeSheet();
      void useRunSetup.getState().begin(reviewThisOptions(run, change));
    },
    draftPlanComment: () => void store.draftPlanComment(id),
    openPlanDraft: () => store.showDraft(run.item),
    draftPlanDescription: () => void store.draftPlanDescription(id),
    openPlanDescription: () => store.showDraft(run.item),
    discussPlanDescription: () => {
      const draft = outcome?.planDescription?.draft;
      if (draft?.state.type !== "pending") return;
      askPip(planDescriptionWithPipPrompt(run, draft.id));
      store.closeSheet();
    },
    openTicketDraft: () => {
      if (!outcome?.ticketDraft) return;
      store.closeSheet();
      showDraft(outcome.ticketDraft.id);
    },
    finishWithPip: () => {
      const draft = outcome?.ticketDraft;
      if (draft?.state.type !== "pending") return;
      askPip(finishWithPipPrompt(run, draft.id));
      store.closeSheet();
      showDraft(draft.id);
    },
    askPipDescription: () => (askPip(descriptionWithPipPrompt(run)), store.closeSheet()),
    askPipBreakdown: () => (askPip(breakdownWithPipPrompt(run, outcome?.subtasksDraft?.state.type === "pending" ? outcome.subtasksDraft.id : waitingOn)), store.closeSheet()),
    openCreated: () => {
      if (!run.createdItem) return;
      store.closeSheet();
      void openTicketByKey(run.createdItem.key);
    },
    openChange: (url) => void openOnGithub(url),
    loadBrief: () => {
      if (brief !== null || !backend) return;
      setBrief("loading");
      backend.runsReview(run.proposalId).then(setBrief, () => setBrief("unavailable"));
    },
  };
  return <RunSheetView run={run} now={now} ticketTitle={ticket?.title ?? null} place={place} label={label} wide={wide} onWide={() => setWide((w) => !w)} events={events} disk={disk} brief={brief} confirmStop={confirmStop} outcome={outcome} tickets={tickets} pickBlocker={pickBlocker} waitingBreakdown={waitingOn !== null} drafting={drafting} answering={answering} opened={opened} cleanup={cleanupReason(run, now, { disk: typeof disk === "number" ? disk : null, change: outcome?.change ?? null })} slotPlace={slotPosition(run, slotLine)} on={on} />;
}

