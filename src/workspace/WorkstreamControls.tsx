import { useEffect, useMemo, useRef, useState } from "react";
import { Switch } from "../components/Switch";
import { RULE_SWITCH, budgetNote, heldText, ruleText } from "../lib/workstreamHold";
import { HELD_BUDGET, TRIPWIRE, WORKSTREAM_RULES, type AutoStartSwitches, type WorkstreamRule, type WorkstreamRules, type WorkstreamView } from "../types";
import { Btn } from "./AgentSheet";
import { usePopover } from "./Popover";
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

function AutomaticSteps({ rules, globals, actions }: { rules: WorkstreamRules; globals: AutoStartSwitches | null; actions: ControlActions }) {
  const { open, setOpen, root } = usePopover();
  return (
    <div ref={root} className="relative">
      <Btn tone="ghost" data-popover-trigger aria-expanded={open} onClick={() => (open || actions.onSteps?.(), setOpen(!open))} className="px-1.5 py-0.5">
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

export interface ControlsViewProps {
  view: WorkstreamView;
  globals: AutoStartSwitches | null;
  actions: ControlActions;
  /** Stop was pressed and waits for the person to confirm. */
  confirmingStop: boolean;
  onConfirmStop(on: boolean): void;
}

/**
 * Under the workstream's line in the Pip pane: the Manage switch, why it is held with Resume, the budget once it runs low,
 * Hold and Stop, and the automatic steps. Everything comes from the workstream's view, the same in the app and the sample.
 */
export function WorkstreamControlsView({ view, globals, actions, confirmingStop, onConfirmStop }: ControlsViewProps) {
  const ws = view.workstream;
  const held = heldText(ws.heldReason, ws.drifted);
  const drift = ws.heldReason === `${TRIPWIRE}basis_drift`;
  const note = budgetNote(view.budget);
  const manage = ws.mode === "manage";
  const box = useRef<HTMLDivElement>(null);
  // Once the confirmation goes, focus goes back to the menu it came from rather than to nowhere.
  const closeConfirm = () => {
    onConfirmStop(false);
    requestAnimationFrame(() => box.current?.querySelector<HTMLElement>('[aria-label="More for this workstream"][data-popover-trigger]')?.focus());
  };
  return (
    <div ref={box} data-workstream-controls={ws.id} data-mode={ws.mode} data-held={ws.heldReason ?? undefined} className="grid gap-1.5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
        <label className="flex items-center gap-1.5" title="In Manage, Pip is woken when a run finishes and the routine next steps start on their own. Pip itself still starts nothing.">
          <Switch checked={manage} aria-label="Manage this workstream" onChange={actions.onManage} />
          <span className="font-semibold text-ws-ink2">Manage</span>
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
      {held && (
        <div role="status" data-held-banner={ws.heldReason} className="flex flex-wrap items-center gap-2 rounded-md border border-ws-warn/40 bg-ws-warn/10 px-2.5 py-1 text-sm text-ws-ink">
          <span className="min-w-0 flex-1">
            {held}
            {drift && (
              <span data-drift-hint className="block text-xs text-ws-ink2">
                Read {ws.itemKey ?? "the ticket"} as it is now before you resume: what Pip planned may no longer fit. Resuming takes it as the new starting point.
              </span>
            )}
          </span>
          <Btn tone="plain" onClick={actions.onResume} className="px-2 py-0.5">
            Resume
          </Btn>
        </div>
      )}
      {note && !(note.level === "spent" && ws.heldReason === HELD_BUDGET) && (
        <p data-budget={note.level} className={`m-0 text-sm ${note.level === "amber" ? "text-ws-warn" : "text-ws-blocked"}`}>
          {note.text}
        </p>
      )}
    </div>
  );
}

/** `WorkstreamControlsView` for workstream `view`, wired to workstreamsStore. */
export function WorkstreamControls({ view }: { view: WorkstreamView }) {
  const globals = useWorkstreams((s) => s.globals);
  const [confirmingStop, setConfirmingStop] = useState(false);
  const id = view.workstream.id;
  const actions = useMemo(() => controlActions(id), [id]);
  return <WorkstreamControlsView view={view} globals={globals} actions={actions} confirmingStop={confirmingStop} onConfirmStop={setConfirmingStop} />;
}
