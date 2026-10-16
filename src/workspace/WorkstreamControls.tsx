import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Switch } from "../components/Switch";
import { needsIn, type Need } from "../lib/needs";
import { nextStep, type NextStep } from "../lib/nextStep";
import { flaggedGaps, ignoredAmong, projectOfKey, SHORT_GAP } from "../lib/clarityLearning";
import { clarityRepliedText, clarityText, type ClarityGap } from "../lib/ticketClarity";
import { adoptOfferText } from "../lib/workstreamAdopt";
import { RULE_SWITCH, STEP_HELP, asksBudget, isHeldByYou, budgetNote, heldBanner, ruleText, stepsLeftText, stepsOf } from "../lib/workstreamHold";
import { ALLOW_MORE_STEPS, HELD_BUDGET, TRIPWIRE, WORKSTREAM_RULES, type AutoStartSwitches, type Proposal, type Run, type WorkstreamEvent, type WorkstreamRule, type WorkstreamRules, type WorkstreamView } from "../types";
import { useWorkspace } from "../workspaceStore";
import { Btn } from "./AgentSheet";
import { giveBackClarity, settleClarityFocus } from "./clarityActions";
import { paneHas, useDecisionShown } from "./decisionShown";
import { EscalationCard } from "./EscalationCard";
import { focusLost } from "./commands";
import { openNeed } from "./needsActions";
import { usePopover } from "./Popover";
import { useRuns } from "./runsStore";
import { usePrefs } from "./prefs";
import { useNeedsYou } from "./useNeeds";
import { useWorkstreams } from "./workstreamsStore";

/** Where one automatic step stands for a workstream: its own switch on or off, or following Settings. */
export type RuleChoice = "on" | "off" | "inherit";

/** The workstream's own choice for `rule`; a rule it doesn't name follows Settings. */
export const ruleChoice = (rules: WorkstreamRules, rule: WorkstreamRule): RuleChoice => (rules[rule] === true ? "on" : rules[rule] === false ? "off" : "inherit");

/** What `workstreamsSetRule` is given for a choice: null follows Settings again. */
export const choiceValue = (choice: RuleChoice): boolean | null => (choice === "on" ? true : choice === "off" ? false : null);

/** The person's controls on one workstream, each a user-only backend command; Pip has a tool for none of them. */
export interface ControlActions {
  onManage(on: boolean): void;
  /** Hold and Resume give back what they wait on, so focus can settle once the banner and the button have swapped. */
  onHold(): void | Promise<unknown>;
  onResume(): void | Promise<unknown>;
  /** "Allow 5 more", the person's answer to a spent budget: the audited way on from a budget hold, which Resume is not. */
  onAllowMore(): void;
  onStop(): void;
  /** Closes the workstream once the person confirmed: its conversation goes back to General, its agents and drafts are kept. */
  onClose?(): void;
  onRule(rule: WorkstreamRule, on: boolean | null): void;
  /** The steps popover opened: what "as in Settings" means is read again. */
  onSteps?(): void;
}

/** Once a workstream closed, its confirm, its controls and its row are gone and the conversation is General's: if the keyboard fell to the page, it goes to General's row, where F6 and j/k carry on. */
export function settleClosedFocus() {
  requestAnimationFrame(() => {
    if (!focusLost(document.activeElement, document.body)) return;
    document.querySelector<HTMLElement>('[data-pip-home] [data-workstream-row="general"]')?.focus();
  });
}

/** The controls of workstream `id`, through workstreamsStore. */
export function controlActions(id: string): ControlActions {
  const ws = () => useWorkstreams.getState();
  return {
    onManage: (on) => void ws().setMode(id, on ? "manage" : "advise"),
    onHold: () => ws().hold(id),
    onResume: () => ws().resume(id),
    onAllowMore: () => void ws().allowMore(id),
    onStop: () => void ws().stop(id),
    onClose: () => void ws().close(id).then((closed) => closed && settleClosedFocus()),
    onRule: (rule, on) => void ws().setRule(id, rule, on),
    onSteps: () => void ws().loadGlobals(),
  };
}

/**
 * Where the keyboard goes once Hold or Resume swapped the button for the other: Hold's button is replaced by the banner's
 * Resume, and Resume's by Hold; either way the Manage switch is the fallback (a hold shown in the decision pane has no banner here).
 */
export const holdFocusTarget = (root: Pick<ParentNode, "querySelector">, after: "hold" | "resume"): HTMLElement | null =>
  root.querySelector<HTMLElement>(after === "hold" ? "[data-ws-resume]" : "[data-ws-hold]") ?? root.querySelector<HTMLElement>('[aria-label="Manage this workstream"]');

/** Once `done` resolves and the page has swapped the buttons, puts the keyboard where `holdFocusTarget` says, if it fell to the page. */
function settleHoldFocus(done: void | Promise<unknown>, after: "hold" | "resume") {
  void Promise.resolve(done).then(() =>
    requestAnimationFrame(() => {
      if (focusLost(document.activeElement, document.body)) holdFocusTarget(document, after)?.focus();
    }),
  );
}

/** The next stop for Tab (or Shift+Tab) among `count` buttons it is kept inside, wrapping at both ends; -1 for any other key. */
export const tabWithin = (ev: Pick<KeyboardEvent, "key" | "shiftKey">, at: number, count: number): number => (ev.key !== "Tab" || count === 0 ? -1 : (at + (ev.shiftKey ? -1 : 1) + count) % count);

const CHOICES: { choice: RuleChoice; label: (global: boolean | null) => string }[] = [
  { choice: "on", label: () => "On" },
  { choice: "off", label: () => "Off" },
  { choice: "inherit", label: (global) => (global === null ? "As in Settings" : `As in Settings (${global ? "on" : "off"})`) },
];

/** The six automatic steps, each with its tri-state choice for this workstream. `globals` is what Settings has, null until read. */
export function AutomaticStepsPanel({ rules, globals, onRule }: { rules: WorkstreamRules; globals: AutoStartSwitches | null; onRule: ControlActions["onRule"] }) {
  return (
    <div role="dialog" aria-label="Automatic steps" className="absolute top-full right-0 z-40 mt-1 grid w-[300px] gap-2 rounded-xl border border-ws-sep2 bg-ws-win p-3 text-sm text-ws-ink shadow-ws-pop">
      <p className="m-0 text-ws-ink2">In Manage, these steps start on their own when the one before finishes. Each can be turned off here for this workstream only.</p>
      <ul className="m-0 grid list-none gap-2 p-0">
        {WORKSTREAM_RULES.map((rule) => {
          const now = ruleChoice(rules, rule);
          const global = globals ? globals[RULE_SWITCH[rule]] : null;
          return (
            <li key={rule} data-rule={rule} data-choice={now} className="grid gap-1">
              <span className="font-semibold">{ruleText(rule)}</span>
              <div role="radiogroup" aria-label={ruleText(rule)} className="flex flex-wrap gap-1">
                {CHOICES.map(({ choice, label }) => (
                  <button
                    key={choice}
                    type="button"
                    role="radio"
                    aria-checked={now === choice}
                    onClick={() => now !== choice && onRule(rule, choiceValue(choice))}
                    className={`rounded-full border px-2 py-0.5 text-xs ${now === choice ? "border-ws-pip bg-ws-pip-soft font-semibold text-ws-ink" : "border-ws-sep2 text-ws-ink2 hover:bg-ws-hover"}`}
                  >
                    {label(global)}
                  </button>
                ))}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** What Hold, Close… and ⋯ do, as the short hints on their buttons say (title for the pointer, aria-description for the screen reader). */
export const HOLD_HINT = "No wakes and no automatic steps; its agents carry on";
export const CLOSE_HINT = "Its conversation goes back to General; its agents and drafts are kept in General";
export const MORE_HINT = "More: stop the workstream";

/** What the Automatic steps button opens, for its tooltip: the routine next steps and who starts them. */
export const AUTO_STEPS_HELP = "Which routine next steps (a review after a build, a plan after a triage) start by themselves in this workstream. Switch any of them off here.";

function AutomaticSteps({ rules, globals, actions }: { rules: WorkstreamRules; globals: AutoStartSwitches | null; actions: ControlActions }) {
  const { open, setOpen, root } = usePopover();
  return (
    <div ref={root} className="relative">
      <Btn tone="ghost" data-popover-trigger aria-expanded={open} title={AUTO_STEPS_HELP} onClick={() => (open || actions.onSteps?.(), setOpen(!open))} className="px-1.5 py-0.5">
        Automatic steps
      </Btn>
      {open && <AutomaticStepsPanel rules={rules} globals={globals} onRule={actions.onRule} />}
    </div>
  );
}

/**
 * Stop sits behind a menu rather than beside Hold: it ends agents, so it takes two deliberate presses, and the pane's
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
      <Btn tone="ghost" aria-label="More for this workstream" title={MORE_HINT} aria-description={MORE_HINT} aria-haspopup="menu" aria-expanded={open} data-popover-trigger onClick={() => setOpen(!open)} className="px-1.5 py-0.5">
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

/** Asks before Stop: it holds the workstream and stops each of its agents that can be stopped. */
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
      <span className="text-ws-ink2">Hold it and stop its agents? What they wrote stays in their worktrees.</span>
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
export function CloseConfirm({ onClose, onKeep }: { onClose(): void; onKeep(): void }) {
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
        <span id={question}>Close it?</span> <span id={detail}>Its conversation goes back to General; its agents and drafts are kept in General.</span>
      </span>
      <Btn tone="primary" onClick={onClose} className="px-2 py-0.5">
        Close workstream
      </Btn>
      <Btn tone="ghost" autoFocus onClick={onKeep} className="px-2 py-0.5">
        Keep
      </Btn>
    </div>
  );
}

/** What counts as an automatic step, under the budget's line or banner. */
function StepHelp() {
  return (
    <details data-step-help className="text-xs text-ws-ink2">
      <summary className="cursor-pointer">What&apos;s an automatic step?</summary>
      {STEP_HELP}
    </details>
  );
}

/** Why the workstream is held, with its Resume (for a budget hold in Manage, Allow 5 more and Switch to Advise instead, as the decision has them); nothing while it isn't held. A hold the system made is also in Needs you, and its decision shows the same banner; the person's own hold is not, so this banner is where it shows. */
export function HeldBanner({ view, actions, waiting: given }: { view: WorkstreamView; actions: Pick<ControlActions, "onResume" | "onAllowMore" | "onManage">; /** How many drafts of this workstream wait in Needs you; read from the store when absent. */ waiting?: number }) {
  const ws = view.workstream;
  const inNeeds = needsIn(useNeedsYou(), ws.id);
  const waiting = given ?? inNeeds;
  const held = heldBanner(ws, view.changedWhileWaiting);
  if (!held) return null;
  const drift = ws.heldReason === `${TRIPWIRE}basis_drift`;
  const byYou = isHeldByYou(ws.heldReason);
  return (
    <div role="group" aria-label="Why this workstream is held" data-held-banner={ws.heldReason} className="flex flex-wrap items-center gap-2 rounded-md border border-ws-warn/40 bg-ws-warn/10 px-2.5 py-1 text-sm text-ws-ink">
      <span className="min-w-0 flex-1">
        {held}
        {drift && (
          <span data-drift-hint className="block text-xs text-ws-ink2">
            Read {ws.itemKey ?? "the ticket"} as it is now before you resume: what Pip planned may no longer fit. Resuming takes it as the new starting point.
          </span>
        )}
        {byYou && (
          <span data-held-by-you className="block text-xs text-ws-ink2">
            You chose this, so the hold itself is not in Needs you{waiting > 0 ? "; drafts already waiting stay there" : ""}. Nothing starts on its own and Pip takes no turns until you resume; its agents carry on.
          </span>
        )}
        {ws.heldReason === HELD_BUDGET && <StepHelp />}
      </span>
      {asksBudget(ws) ? (
        <>
          <Btn tone="primary" onClick={actions.onAllowMore} className="px-2 py-0.5">
            Allow {ALLOW_MORE_STEPS} more
          </Btn>
          <Btn tone="plain" onClick={() => actions.onManage(false)} className="px-2 py-0.5">
            Switch to Advise
          </Btn>
        </>
      ) : (
        <Btn tone="plain" data-ws-resume onClick={() => settleHoldFocus(actions.onResume(), "resume")} className="px-2 py-0.5">
          Resume
        </Btn>
      )}
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
          {`They wrote: “${view.reporterReply.excerpt}”`}
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
  globals: AutoStartSwitches | null;
  actions: ControlActions;
  /** Stop was pressed and waits for the person to confirm. */
  confirmingStop: boolean;
  onConfirmStop(on: boolean): void;
  /** Close was pressed and waits for the person to confirm; left out where a workstream can't be closed from here. */
  confirmingClose?: boolean;
  onConfirmClose?(on: boolean): void;
  /** What comes next, from `nextStep`; absent where it isn't known (the line is left out). */
  next?: NextStep | null;
}

/** What the Manage switch does when it is on and when it is off, for its visible text and its description. */
export const MANAGE_STATE: Record<"on" | "off", string> = {
  on: "on: Pip starts the next steps",
  off: "off: Pip only answers",
};

/** What the mode switch means, one line under it: Manage starts and drafts by itself, Advise only answers. */
export const MODE_LINE: Record<"manage" | "advise", string> = {
  manage: "Pip manages: after each step finishes it starts the next one and drafts what's next. Gossamr posts nothing to Jira without you; a Build runs with your Claude settings and could reach Jira or GitHub itself.",
  advise: "Pip advises: it answers when asked and starts nothing by itself.",
};

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
 * Under the workstream's line in the Pip pane: the Manage switch, why it is held with Resume, a review that still blocks
 * after the fix rounds with the person's choices, the budget once it runs low, Hold and Stop, and the automatic steps. Everything comes from the workstream's view, the same in the app and the sample.
 */
export function WorkstreamControlsView({ view, globals, actions, confirmingStop, onConfirmStop, confirmingClose = false, onConfirmClose, next }: ControlsViewProps) {
  const ws = view.workstream;
  const note = budgetNote(view.budget);
  const manage = ws.mode === "manage";
  const pausedId = useId();
  const modeLineId = useId();
  const box = useRef<HTMLDivElement>(null);
  // A decision open in Pip home's pane is shown there, not here as well.
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
    <div ref={box} data-workstream-controls={ws.id} data-mode={ws.mode} data-held={ws.heldReason ?? undefined} className="grid gap-1.5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
        <label className="flex items-center gap-1.5" title="In Manage, Pip is woken when a run finishes and the routine next steps start on their own. Pip itself still starts nothing.">
          <Switch checked={manage} aria-label="Manage this workstream" aria-describedby={ws.resumeMode === "manage" ? `${pausedId} ${modeLineId}` : modeLineId} onChange={actions.onManage} />
          <span className="font-semibold text-ws-ink2">Manage</span>
          <span data-manage-state={manage ? "on" : "off"} className="text-xs text-ws-ink3">
            {manage ? MANAGE_STATE.on : MANAGE_STATE.off}
          </span>
          {ws.resumeMode === "manage" && (
            <span id={pausedId} data-manage-paused className="text-xs text-ws-ink3">
              paused<span className="sr-only"> until Resume</span>
            </span>
          )}
        </label>
        <AutomaticSteps rules={ws.rules} globals={globals} actions={actions} />
        <span className="ml-auto flex items-center gap-1">
          {!ws.heldReason && (
            <Btn tone="ghost" data-ws-hold onClick={() => settleHoldFocus(actions.onHold(), "hold")} title={HOLD_HINT} aria-description={HOLD_HINT} className="px-1.5 py-0.5">
              Hold
            </Btn>
          )}
          {/* Both, or nothing: a Close whose confirm could close nothing is not offered. */}
          {onConfirmClose && actions.onClose && (
            <Btn tone="ghost" data-close-workstream onClick={() => onConfirmClose(true)} title={CLOSE_HINT} aria-description={CLOSE_HINT} className="px-1.5 py-0.5">
              Close…
            </Btn>
          )}
          <MoreMenu onStop={() => onConfirmStop(true)} />
        </span>
        {confirmingStop && <StopConfirm onStop={() => (closeConfirm(), actions.onStop())} onKeep={closeConfirm} />}
        {confirmingClose && onConfirmClose && actions.onClose && <CloseConfirm onClose={actions.onClose} onKeep={keepOpen} />}
      </div>
      <p id={modeLineId} data-mode-line={ws.mode} className="m-0 text-xs text-ws-ink2">
        {MODE_LINE[ws.mode]}
      </p>
      {!paneHas(shown, "hold", ws.id) && <HeldBanner view={view} actions={actions} />}
      {/* A review that still blocks after the automatic fix rounds: the person chooses what happens next. */}
      {!paneHas(shown, "escalation", ws.id) && <EscalationCard key={ws.id} view={view} />}
      <AdoptNotice view={view} />
      <ClarityNotice view={view} />
      {next && <NextStepLine next={next} workstreamId={ws.id} />}
      {manage && (
        <p data-steps-left={stepsOf(view.budget).limit - stepsOf(view.budget).used} title={STEP_HELP} className="m-0 text-xs text-ws-ink2">
          {stepsLeftText(view.budget)}
        </p>
      )}
      {note && !(note.level === "spent" && ws.heldReason === HELD_BUDGET) && (
        <div className="grid gap-0.5">
          <p data-budget={note.level} title={STEP_HELP} className={`m-0 text-sm ${note.level === "amber" ? "text-ws-warn" : "text-ws-blocked"}`}>
            {note.text}
          </p>
          <StepHelp />
        </div>
      )}
    </div>
  );
}

/**
 * The Next line's step, or null (the line stays hidden) while Settings' switches are unread: guessing from the defaults could
 * promise a step the person's saved settings switched off.
 */
export function nextStepOnceKnown(view: WorkstreamView, runs: Run[], proposals: Proposal[], needs: Need[], globals: AutoStartSwitches | null, events: readonly WorkstreamEvent[] = []): NextStep | null {
  return globals ? nextStep(view, runs, proposals, needs, globals, events) : null;
}

const NO_EVENTS: readonly WorkstreamEvent[] = [];

/** `WorkstreamControlsView` for workstream `view`, wired to workstreamsStore. */
export function WorkstreamControls({ view }: { view: WorkstreamView }) {
  const globals = useWorkstreams((s) => s.globals);
  const [confirmingStop, setConfirmingStop] = useState(false);
  const id = view.workstream.id;
  const actions = useMemo(() => controlActions(id), [id]);
  const runs = useRuns((s) => s.runs);
  const proposals = useWorkspace((s) => s.proposals);
  const needs = useNeedsYou();
  const events = useWorkstreams((s) => s.events[id]) ?? NO_EVENTS;
  const confirmingClose = useWorkstreams((s) => s.confirmingClose === id);
  const next = useMemo(() => nextStepOnceKnown(view, runs, Object.values(proposals), needs, globals, events), [view, runs, proposals, needs, globals, events]);
  return <WorkstreamControlsView view={view} globals={globals} actions={actions} confirmingStop={confirmingStop} onConfirmStop={setConfirmingStop} confirmingClose={confirmingClose} onConfirmClose={(on) => useWorkstreams.getState().askClose(on ? id : null)} next={next} />;
}
