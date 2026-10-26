import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { inWorkstreamPane } from "../lib/proposals";
import { nextStep, type NextStep } from "../lib/nextStep";
import { flaggedGaps, ignoredAmong, projectOfKey, SHORT_GAP } from "../lib/clarityLearning";
import { clarityRepliedText, clarityText, type ClarityGap } from "../lib/ticketClarity";
import { maskSecrets } from "../lib/riskyText";
import { adoptOfferText } from "../lib/workstreamAdopt";
import { pausedBanner } from "../lib/workstreamPause";
import type { WorkstreamView } from "../types";
import { useWorkspace } from "../workspaceStore";
import { Btn } from "./AgentSheet";
import { giveBackClarity, settleClarityFocus } from "./clarityActions";
import { paneHas, useDecisionShown } from "./decisionShown";
import { focusLost } from "./commands";
import { openNeed } from "./needsActions";
import { usePopover } from "./Popover";
import { useRuns } from "./runsStore";
import { usePrefs } from "./prefs";
import { useNeedsYou } from "./useNeeds";
import { useWorkstreams } from "./workstreamsStore";

/** The person's controls on one workstream, each a user-only backend command; Pip has a tool for none of them. */
export interface ControlActions {
  /** Pause and Resume give back what they wait on, so focus can settle once the banner and the button have swapped. */
  onPause(): void | Promise<unknown>;
  onResume(): void | Promise<unknown>;
  onStop(): void;
  /** Closes the workstream once the person confirmed: its conversation goes back to General, its agents and drafts are kept. */
  onClose?(): void;
}

/** Once a workstream closed, its confirm, its controls and its detail are gone: if the keyboard fell to the page, it goes to the Agents heading, where Tab carries on. */
export function settleClosedFocus() {
  requestAnimationFrame(() => {
    if (!focusLost(document.activeElement, document.body)) return;
    document.querySelector<HTMLElement>("[data-agents-home] h1")?.focus();
  });
}

/** The controls of workstream `id`, through workstreamsStore. */
export function controlActions(id: string): ControlActions {
  const ws = () => useWorkstreams.getState();
  return {
    onPause: () => ws().pause(id),
    onResume: () => ws().resume(id),
    onStop: () => void ws().stop(id),
    onClose: () => void ws().close(id).then((closed) => closed && settleClosedFocus()),
  };
}

/**
 * Where the keyboard goes once Pause or Resume swapped the button for the other: Pause's button is replaced by the banner's
 * Resume, and Resume's by Pause; either way Close is the fallback (a pause shown in the decision pane has no banner here).
 */
export const pauseFocusTarget = (root: Pick<ParentNode, "querySelector">, after: "pause" | "resume"): HTMLElement | null =>
  root.querySelector<HTMLElement>(after === "pause" ? "[data-ws-resume]" : "[data-ws-pause]") ?? root.querySelector<HTMLElement>("[data-close-workstream]");

/** Once `done` resolves and the page has swapped the buttons, puts the keyboard where `pauseFocusTarget` says, if it fell to the page. */
function settlePauseFocus(done: void | Promise<unknown>, after: "pause" | "resume") {
  // The workstream's controls show in its detail and in Pip's header; the keyboard stays in the one it was in.
  const scope = document.activeElement?.closest("[data-workstream-controls]") ?? document;
  void Promise.resolve(done).then(() =>
    requestAnimationFrame(() => {
      if (focusLost(document.activeElement, document.body)) pauseFocusTarget(scope.isConnected ? scope : document, after)?.focus();
    }),
  );
}

/** The next stop for Tab (or Shift+Tab) among `count` buttons it is kept inside, wrapping at both ends; -1 for any other key. */
export const tabWithin = (ev: Pick<KeyboardEvent, "key" | "shiftKey">, at: number, count: number): number => (ev.key !== "Tab" || count === 0 ? -1 : (at + (ev.shiftKey ? -1 : 1) + count) % count);

/** What Pause, Close… and ⋯ do, as the short hints on their buttons say (title for the pointer, aria-description for the screen reader). */
export const PAUSE_HINT = "Pip isn't woken; its agents carry on";
export const CLOSE_HINT = "Its conversation goes back to General; its agents and drafts are kept in General";
/** What Close does to the agents of the workstream, said in its confirm: closing stops none, and a queued one does not start while the workstream is closed (`workstream_runs` in src-tauri/src/runs/service.rs). */
export const CLOSE_RUNS_NOTE = "Agents already running carry on; one still queued does not start while it is closed.";
/** What Close leaves waiting, said in its confirm when drafts are still open: they are not decided by closing. */
export const CLOSE_DRAFTS_NOTE = (count: number) => `${count === 1 ? "1 draft is still waiting and stays" : `${count} drafts are still waiting and stay`} in General.`;
export const MORE_HINT = "More: stop the workstream";

/**
 * Stop sits behind a menu rather than beside Pause: it ends agents, so it takes two deliberate presses, and the pane's
 * own Stop (for Pip's answer) stays the only button of that name there.
 */
function MoreMenu({ onStop }: { onStop(): void }) {
  const { open, setOpen, root } = usePopover();
  // A menu takes focus to its first item when it opens, as the keyboard expects.
  useEffect(() => {
    if (open) root.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [open, root]);
  return (
    <div ref={root} className="relative">
      <Btn tone="plain" aria-label="More for this workstream" title={MORE_HINT} aria-description={MORE_HINT} aria-haspopup="menu" aria-expanded={open} data-popover-trigger onClick={() => setOpen(!open)} className="px-1.5 py-0.5">
        ⋯
      </Btn>
      {open && (
        <div role="menu" aria-label="More for this workstream" className="absolute top-full right-0 z-40 mt-1 w-[220px] rounded-xl border border-ws-sep2 bg-ws-win py-1 text-sm shadow-ws-pop">
          <button type="button" role="menuitem" onClick={() => (setOpen(false), onStop())} className="block w-full px-3 py-1.5 text-left text-ws-blocked hover:bg-ws-hover focus-visible:bg-ws-hover">
            Stop the workstream…
          </button>
        </div>
      )}
    </div>
  );
}

/** Asks before Stop: it pauses the workstream and stops each of its agents that can be stopped. */
export function StopConfirm({ onStop, onKeep }: { onStop(): void; onKeep(): void }) {
  return (
    <div
      role="group"
      aria-label="Stop this workstream"
      data-esc-local
      className="flex basis-full flex-wrap items-center gap-2 text-sm"
      onKeyDown={(ev) => {
        if (ev.key === "Escape") (ev.stopPropagation(), onKeep());
      }}
    >
      <span className="text-ws-ink2">Pause it and stop its agents? What they wrote stays in their worktrees.</span>
      <Btn tone="dangerFill" autoFocus onClick={onStop} className="px-2 py-0.5">
        Yes, stop
      </Btn>
      <Btn tone="ghost" onClick={onKeep} className="px-2 py-0.5">
        Keep going
      </Btn>
    </div>
  );
}

/** Asks before Close: the workstream goes, its agents and drafts stay. Tab stays between its two buttons while it is open. */
export function CloseConfirm({ onClose, onKeep, drafts = 0 }: { onClose(): void; onKeep(): void; /** Drafts still waiting for a decision, which stay with the person in General. */ drafts?: number }) {
  const question = useId();
  const detail = useId();
  return (
    <div
      role="group"
      aria-label="Close this workstream"
      aria-describedby={`${question} ${detail}`}
      data-close-confirm
      data-esc-local
      className="flex basis-full flex-wrap items-center gap-2 text-sm"
      onKeyDown={(ev) => {
        if (ev.key === "Escape") return void (ev.stopPropagation(), onKeep());
        const buttons = Array.from(ev.currentTarget.querySelectorAll<HTMLElement>("button"));
        const to = tabWithin(ev, buttons.indexOf(document.activeElement as HTMLElement), buttons.length);
        if (to >= 0) (ev.preventDefault(), buttons[to].focus());
      }}
    >
      <span className="text-ws-ink2">
        <span id={question}>Close it?</span> <span id={detail}>Its conversation goes back to General; its agents and drafts are kept in General. {drafts > 0 ? `${CLOSE_DRAFTS_NOTE(drafts)} ` : ""}{CLOSE_RUNS_NOTE}</span>
      </span>
      <Btn tone="primary" onClick={onClose} className="px-2 py-0.5">
        Close workstream
      </Btn>
      <Btn tone="ghost" autoFocus aria-describedby={`${question} ${detail}`} onClick={onKeep} className="px-2 py-0.5">
        Keep
      </Btn>
    </div>
  );
}

/** Why the workstream is paused, with its Resume; nothing while it isn't paused. A pause is also in Needs you, and its decision shows the same banner. */
export function PausedBanner({ view, actions }: { view: WorkstreamView; actions: Pick<ControlActions, "onResume"> }) {
  const ws = view.workstream;
  const paused = pausedBanner(ws.pausedReason);
  if (!paused) return null;
  return (
    <div role="group" aria-label="Why this workstream is paused" data-paused-banner={ws.pausedReason} className="flex flex-wrap items-center gap-2 rounded-md border border-ws-warn/40 bg-ws-warn/10 px-2.5 py-1 text-sm text-ws-ink">
      <span className="min-w-0 flex-1">{paused}</span>
      <Btn tone="plain" data-ws-resume onClick={() => settlePauseFocus(actions.onResume(), "resume")} className="px-2 py-0.5">
        Resume
      </Btn>
    </div>
  );
}

/**
 * Runs and pending drafts on the workstream's ticket that sit under General: one line that says so, with a button that
 * brings them in. Never done on its own; the toast that follows has an Undo.
 */
export function AdoptNotice({ view }: { view: WorkstreamView }) {
  const a = view.adoptable;
  const [busy, setBusy] = useState(false);
  if (!a || (!a.runs.length && !a.drafts.length)) return null;
  const id = view.workstream.id;
  return (
    <div role="group" aria-label="Under General" data-adopt-notice={id} className="flex flex-wrap items-baseline gap-x-2 gap-y-1 rounded-md border border-ws-sep bg-ws-bar px-2.5 py-1.5 text-sm text-ws-ink2">
      <p data-adopt-text className="m-0">
        {adoptOfferText(view.workstream.itemKey ?? "this ticket", a.runs.length, a.drafts.length)}
      </p>
      <Btn tone="plain" data-adopt disabled={busy} onClick={() => (setBusy(true), void useWorkstreams.getState().adopt(id).finally(() => setBusy(false)))} className="px-2 py-0.5">
        Bring them here
      </Btn>
    </div>
  );
}

/** What a live region says: `line` once it differs from what it said when the workstream was opened, else nothing, so opening a workstream announces nothing and a change does. */
export const changedLine = (opened: string, line: string): string => (line && line !== opened ? line : "");

function useChangedLine(scope: string, line: string): string {
  // State, not a ref: a render React throws away can't leave another workstream's opening line behind. Switching
  // workstreams resets it during render, which React supports, and that render (an opening) announces nothing.
  const [first, setFirst] = useState({ scope, line });
  if (first.scope !== scope) {
    setFirst({ scope, line });
    return "";
  }
  return changedLine(first.line, line);
}

/**
 * A ticket Gossamr's own word check found thin, before any triage: what it leaves out, with "Ask the reporter now" (the
 * comment to the reporter, for approval) and "Looks fine". It is a notice, not a need: it blocks and counts nothing, and
 * the triage's verdict stays the authority.
 */
export function ClarityNotice({ view }: { view: WorkstreamView }) {
  const c = view.clarity;
  const learning = usePrefs((s) => s.clarityLearning);
  const [busy, setBusy] = useState(false);
  // What "Looks fine" taught Gossamr to leave out for the ticket's project is not said in the notice; a notice with nothing left is not shown.
  const project = projectOfKey(view.workstream.itemKey ?? "");
  const gaps = c ? flaggedGaps(c.gaps, learning, project) : [];
  const spoken = gaps.length ? `${view.workstream.itemKey ?? "This ticket"}${view.reporterReplied ? ": the reporter replied" : " may be unclear"}` : "";
  const heard = useChangedLine(view.workstream.id, spoken);
  if (!c) return null;
  const quiet = ignoredAmong(c.gaps, learning, project);
  if (!gaps.length) return quiet.length ? <QuietClarity view={view} project={project} gaps={quiet} /> : null;
  const id = view.workstream.id;
  const choose = (call: () => Promise<boolean>) => {
    setBusy(true);
    void call().finally(() => (setBusy(false), settleClarityFocus(id)));
  };
  const store = useWorkstreams.getState();
  return (
    <>
    {/* The toast announces what started; the notice itself is a group, so its buttons are not read as a status. */}
    <span role="status" data-clarity-status className="sr-only">
      {heard}
    </span>
    <div role="group" aria-label="Ticket wording check" data-clarity-notice={id} className="grid gap-1 rounded-md border border-ws-warn/40 bg-ws-warn/10 px-2.5 py-1.5 text-sm text-ws-ink">
      <p data-clarity-text className="m-0">
        {view.reporterReplied ? clarityRepliedText(view.workstream.itemKey ?? "This ticket") : clarityText(view.workstream.itemKey ?? "This ticket", gaps)}
      </p>
      {view.reporterReply && (
        <p data-clarity-reply className="m-0 text-sm whitespace-pre-line text-ws-ink2 [overflow-wrap:anywhere]">
          {`They wrote: “${maskSecrets(view.reporterReply.excerpt)}”`}
        </p>
      )}
      <p className="m-0 text-xs text-ws-ink2">This is a quick check of the words, not a verdict. It holds nothing up; the triage still decides whether the ticket is ready to plan.</p>
      <div className="flex flex-wrap items-center gap-2">
        <Btn tone="plain" disabled={busy} onClick={() => choose(() => store.askReporterNow(id))} className="px-2 py-0.5">
          Ask the reporter now
        </Btn>
        <Btn tone="ghost" disabled={busy} onClick={() => choose(() => store.looksFine(id))} className="px-2 py-0.5">
          Looks fine
        </Btn>
      </div>
      {quiet.length > 0 && <QuietClarity view={view} project={project} gaps={quiet} inside />}
    </div>
    </>
  );
}

/** What the notice leaves out because of what "Looks fine" taught: said quietly, with a way to flag it again. Alone when nothing else is flagged, else under the notice. */
export function QuietClarity({ view, project, gaps, inside = false }: { view: WorkstreamView; project: string; gaps: readonly ClarityGap[]; inside?: boolean }) {
  const [busy, setBusy] = useState(false);
  return (
    <p data-clarity-quiet={view.workstream.id} className={`m-0 flex flex-wrap items-baseline gap-x-2 text-xs text-ws-ink2 ${inside ? "" : "px-1"}`}>
      <span>
        Not flagged: you said Looks fine to {gaps.map((g) => SHORT_GAP[g]).join(" and ")} in {project} tickets.
      </span>
      <button type="button" disabled={busy} onClick={() => (setBusy(true), void giveBackClarity(project, gaps).finally(() => (setBusy(false), settleClarityFocus(view.workstream.id))))} className="rounded px-1 font-medium text-ws-ink underline hover:bg-ws-hover focus-visible:outline-2 focus-visible:outline-ws-pip">
        {`Flag again in ${project}`}
      </button>
    </p>
  );
}

export interface ControlsViewProps {
  view: WorkstreamView;
  actions: ControlActions;
  /** Stop was pressed and waits for the person to confirm. */
  confirmingStop: boolean;
  onConfirmStop(on: boolean): void;
  /** Close was pressed and waits for the person to confirm; left out where a workstream can't be closed from here. */
  confirmingClose?: boolean;
  onConfirmClose?(on: boolean): void;
  /** Drafts of the workstream still waiting, which Close leaves for General: its confirm counts them. */
  openDrafts?: number;
  /** What comes next, from `nextStep`; absent where it isn't known (the line is left out). */
  next?: NextStep | null;
}

/**
 * The one line that says what happens next. When it is waiting on the person, the line opens the top need in the Needs-you pane.
 * When the reporter has been silent for days (`next.nudge`), "Draft a nudge" sits beside it: a short follow-up comment, for approval.
 */
export function NextStepLine({ next, workstreamId }: { next: NextStep; workstreamId?: string }) {
  const { need } = next;
  const [busy, setBusy] = useState(false);
  return (
    <p data-next-step={next.kind} className="m-0 text-sm text-ws-ink">
      {need ? (
        <button type="button" data-next-step-need={need.key} onClick={() => openNeed(need)} className="text-left underline decoration-ws-sep2 underline-offset-2 hover:bg-ws-hover">
          {next.text}
        </button>
      ) : (
        next.text
      )}
      {next.nudge && workstreamId && (
        <>
          {" "}
          <Btn tone="plain" data-nudge disabled={busy} onClick={() => (setBusy(true), void useWorkstreams.getState().nudgeReporter(workstreamId).finally(() => setBusy(false)))} className="px-2 py-0.5">
            Draft a nudge
          </Btn>
        </>
      )}
    </p>
  );
}

/**
 * Under the workstream's line in the Pip pane: why it is paused with Resume, Pause and Stop, and what comes next. Everything
 * comes from the workstream's view, the same in the app and the sample.
 */
export function WorkstreamControlsView({ view, actions, confirmingStop, onConfirmStop, confirmingClose = false, onConfirmClose, openDrafts = 0, next }: ControlsViewProps) {
  const ws = view.workstream;
  const box = useRef<HTMLDivElement>(null);
  // A decision open in the Agents decision pane is shown there, not here as well.
  const shown = useDecisionShown();
  // Once the confirmation goes, focus goes back to the menu it came from rather than to nowhere.
  const closeConfirm = () => {
    onConfirmStop(false);
    requestAnimationFrame(() => box.current?.querySelector<HTMLElement>('[aria-label="More for this workstream"][data-popover-trigger]')?.focus());
  };
  // Keep, or Esc, takes the question away with the button that had the keyboard: it goes back to Close, as Stop's does to its menu.
  const keepOpen = () => {
    onConfirmClose?.(false);
    requestAnimationFrame(() => box.current?.querySelector<HTMLElement>("[data-close-workstream]")?.focus());
  };
  return (
    <div ref={box} data-workstream-controls={ws.id} data-paused={ws.pausedReason ?? undefined} className="grid gap-1.5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
        <span className="ml-auto flex items-center gap-1">
          {!ws.pausedReason && (
            <Btn tone="plain" data-ws-pause onClick={() => settlePauseFocus(actions.onPause(), "pause")} title={PAUSE_HINT} aria-description={PAUSE_HINT} className="px-1.5 py-0.5">
              Pause
            </Btn>
          )}
          {/* Both, or nothing: a Close whose confirm could close nothing is not offered. */}
          {onConfirmClose && actions.onClose && (
            <Btn tone="plain" data-close-workstream onClick={() => onConfirmClose(true)} title={CLOSE_HINT} aria-description={CLOSE_HINT} className="px-1.5 py-0.5">
              Close…
            </Btn>
          )}
          <MoreMenu onStop={() => onConfirmStop(true)} />
        </span>
        {confirmingStop && <StopConfirm onStop={() => (closeConfirm(), actions.onStop())} onKeep={closeConfirm} />}
        {confirmingClose && onConfirmClose && actions.onClose && <CloseConfirm onClose={actions.onClose} onKeep={keepOpen} drafts={openDrafts} />}
      </div>
      {!paneHas(shown, "paused", ws.id) && <PausedBanner view={view} actions={actions} />}
      <AdoptNotice view={view} />
      <ClarityNotice view={view} />
      {next && <NextStepLine next={next} workstreamId={ws.id} />}
    </div>
  );
}

/** `WorkstreamControlsView` for workstream `view`, wired to workstreamsStore. */
export function WorkstreamControls({ view }: { view: WorkstreamView }) {
  const [confirmingStop, setConfirmingStop] = useState(false);
  const id = view.workstream.id;
  const actions = useMemo(() => controlActions(id), [id]);
  const runs = useRuns((s) => s.runs);
  const proposals = useWorkspace((s) => s.proposals);
  const needs = useNeedsYou();
  const confirmingClose = useWorkstreams((s) => s.confirmingClose === id);
  const next = useMemo(() => nextStep(view, runs, Object.values(proposals), needs), [view, runs, proposals, needs]);
  const openDrafts = useMemo(() => Object.values(proposals).filter((p) => p.state.type === "pending" && inWorkstreamPane(p, view.workstream)).length, [proposals, view.workstream]);
  return <WorkstreamControlsView view={view} actions={actions} confirmingStop={confirmingStop} onConfirmStop={setConfirmingStop} confirmingClose={confirmingClose} onConfirmClose={(on) => useWorkstreams.getState().askClose(on ? id : null)} openDrafts={openDrafts} next={next} />;
}
