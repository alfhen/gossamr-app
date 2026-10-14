import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Switch } from "../components/Switch";
import type { Need } from "../lib/needs";
import { nextStep, type NextStep } from "../lib/nextStep";
import { flaggedGaps, ignoredAmong, projectOfKey, SHORT_GAP } from "../lib/clarityLearning";
import { clarityRepliedText, clarityText, type ClarityGap } from "../lib/ticketClarity";
import { RULE_SWITCH, STEP_HELP, asksBudget, isHeldByYou, budgetNote, heldBanner, ruleText, stepsLeftText, stepsOf } from "../lib/workstreamHold";
import { ALLOW_MORE_STEPS, HELD_BUDGET, TRIPWIRE, WORKSTREAM_RULES, type AutoStartSwitches, type Proposal, type Run, type WorkstreamEvent, type WorkstreamRule, type WorkstreamRules, type WorkstreamView } from "../types";
import { useWorkspace } from "../workspaceStore";
import { Btn } from "./AgentSheet";
import { giveBackClarity } from "./clarityActions";
import { paneHas, useDecisionShown } from "./decisionShown";
import { EscalationCard } from "./EscalationCard";
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
  onHold(): void;
  onResume(): void;
  /** "Allow 5 more", the person's answer to a spent budget: the audited way on from a budget hold, which Resume is not. */
  onAllowMore(): void;
  onStop(): void;
  onRule(rule: WorkstreamRule, on: boolean | null): void;
  /** The steps popover opened: what "as in Settings" means is read again. */
  onSteps?(): void;
}

/** The controls of workstream `id`, through workstreamsStore. */
export function controlActions(id: string): ControlActions {
  const ws = () => useWorkstreams.getState();
  return {
    onManage: (on) => void ws().setMode(id, on ? "manage" : "advise"),
    onHold: () => void ws().hold(id),
    onResume: () => void ws().resume(id),
    onAllowMore: () => void ws().allowMore(id),
    onStop: () => void ws().stop(id),
    onRule: (rule, on) => void ws().setRule(id, rule, on),
    onSteps: () => void ws().loadGlobals(),
  };
}

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
      <Btn tone="ghost" aria-label="More for this workstream" aria-haspopup="menu" aria-expanded={open} data-popover-trigger onClick={() => setOpen(!open)} className="px-1.5 py-0.5">
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
export function HeldBanner({ view, actions }: { view: WorkstreamView; actions: Pick<ControlActions, "onResume" | "onAllowMore" | "onManage"> }) {
  const ws = view.workstream;
  const held = heldBanner(ws, view.changedWhileWaiting);
  if (!held) return null;
  const drift = ws.heldReason === `${TRIPWIRE}basis_drift`;
  const byYou = isHeldByYou(ws.heldReason);
  return (
    <div role="status" data-held-banner={ws.heldReason} className="flex flex-wrap items-center gap-2 rounded-md border border-ws-warn/40 bg-ws-warn/10 px-2.5 py-1 text-sm text-ws-ink">
      <span className="min-w-0 flex-1">
        {held}
        {drift && (
          <span data-drift-hint className="block text-xs text-ws-ink2">
            Read {ws.itemKey ?? "the ticket"} as it is now before you resume: what Pip planned may no longer fit. Resuming takes it as the new starting point.
          </span>
        )}
        {byYou && (
          <span data-held-by-you className="block text-xs text-ws-ink2">
            You chose this, so it is not in Needs you. Nothing starts on its own and Pip takes no turns until you resume; its agents carry on.
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
        <Btn tone="plain" onClick={actions.onResume} className="px-2 py-0.5">
          Resume
        </Btn>
      )}
    </div>
  );
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
  if (!c) return null;
  // What "Looks fine" taught Gossamr to leave out for the ticket's project is not said in the notice; a notice with nothing left is not shown.
  const project = projectOfKey(view.workstream.itemKey ?? "");
  const gaps = flaggedGaps(c.gaps, learning, project);
  const quiet = ignoredAmong(c.gaps, learning, project);
  if (!gaps.length) return quiet.length ? <QuietClarity view={view} project={project} gaps={quiet} /> : null;
  const id = view.workstream.id;
  const choose = (call: () => Promise<boolean>) => {
    setBusy(true);
    void call().finally(() => setBusy(false));
  };
  const store = useWorkstreams.getState();
  return (
    <div role="status" data-clarity-notice={id} className="grid gap-1 rounded-md border border-ws-warn/40 bg-ws-warn/10 px-2.5 py-1.5 text-sm text-ws-ink">
      <p data-clarity-text className="m-0">
        {view.reporterReplied ? clarityRepliedText(view.workstream.itemKey ?? "This ticket") : clarityText(view.workstream.itemKey ?? "This ticket", gaps)}
      </p>
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
  );
}

/** What the notice leaves out because of what "Looks fine" taught: said quietly, with a way to flag it again. Alone when nothing else is flagged, else under the notice. */
export function QuietClarity({ view, project, gaps, inside = false }: { view: WorkstreamView; project: string; gaps: readonly ClarityGap[]; inside?: boolean }) {
  const [busy, setBusy] = useState(false);
  return (
    <p data-clarity-quiet={view.workstream.id} className={`m-0 flex flex-wrap items-baseline gap-x-2 text-xs text-ws-ink3 ${inside ? "" : "px-1"}`}>
      <span>
        Not flagged: you said Looks fine to {gaps.map((g) => SHORT_GAP[g]).join(" and ")} in {project} tickets.
      </span>
      <button type="button" disabled={busy} onClick={() => (setBusy(true), void giveBackClarity(project, gaps).finally(() => setBusy(false)))} className="rounded px-1 underline hover:bg-ws-hover focus-visible:outline-2 focus-visible:outline-ws-pip">
        Flag again
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
  /** What comes next, from `nextStep`; absent where it isn't known (the line is left out). */
  next?: NextStep | null;
}

/** What the mode switch means, one line under it: Manage starts and drafts by itself, Advise only answers. */
export const MODE_LINE: Record<"manage" | "advise", string> = {
  manage: "Pip manages: it starts the next step by itself and drafts what's next; nothing reaches Jira without you.",
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
export function WorkstreamControlsView({ view, globals, actions, confirmingStop, onConfirmStop, next }: ControlsViewProps) {
  const ws = view.workstream;
  const note = budgetNote(view.budget);
  const manage = ws.mode === "manage";
  const pausedId = useId();
  const box = useRef<HTMLDivElement>(null);
  // A decision open in Pip home's pane is shown there, not here as well.
  const shown = useDecisionShown();
  // Once the confirmation goes, focus goes back to the menu it came from rather than to nowhere.
  const closeConfirm = () => {
    onConfirmStop(false);
    requestAnimationFrame(() => box.current?.querySelector<HTMLElement>('[aria-label="More for this workstream"][data-popover-trigger]')?.focus());
  };
  return (
    <div ref={box} data-workstream-controls={ws.id} data-mode={ws.mode} data-held={ws.heldReason ?? undefined} className="grid gap-1.5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
        <label className="flex items-center gap-1.5" title="In Manage, Pip is woken when a run finishes and the routine next steps start on their own. Pip itself still starts nothing.">
          <Switch checked={manage} aria-label="Manage this workstream" aria-describedby={ws.resumeMode === "manage" ? pausedId : undefined} onChange={actions.onManage} />
          <span className="font-semibold text-ws-ink2">Manage</span>
          {ws.resumeMode === "manage" && (
            <span id={pausedId} data-manage-paused className="text-xs text-ws-ink3">
              paused<span className="sr-only"> until Resume</span>
            </span>
          )}
        </label>
        <AutomaticSteps rules={ws.rules} globals={globals} actions={actions} />
        <span className="ml-auto flex items-center gap-1">
          {!ws.heldReason && (
            <Btn tone="ghost" onClick={actions.onHold} title="No wakes and no automatic steps; its agents carry on" className="px-1.5 py-0.5">
              Hold
            </Btn>
          )}
          <MoreMenu onStop={() => onConfirmStop(true)} />
        </span>
        {confirmingStop && <StopConfirm onStop={() => (closeConfirm(), actions.onStop())} onKeep={closeConfirm} />}
      </div>
      <p data-mode-line={ws.mode} className="m-0 text-xs text-ws-ink2">
        {MODE_LINE[ws.mode]}
      </p>
      {!paneHas(shown, "hold", ws.id) && <HeldBanner view={view} actions={actions} />}
      {/* A review that still blocks after the automatic fix rounds: the person chooses what happens next. */}
      {!paneHas(shown, "escalation", ws.id) && <EscalationCard key={ws.id} view={view} />}
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
  const next = useMemo(() => nextStepOnceKnown(view, runs, Object.values(proposals), needs, globals, events), [view, runs, proposals, needs, globals, events]);
  return <WorkstreamControlsView view={view} globals={globals} actions={actions} confirmingStop={confirmingStop} onConfirmStop={setConfirmingStop} next={next} />;
}
