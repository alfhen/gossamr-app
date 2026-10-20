import { useEffect } from "react";
import { needsIn } from "../lib/needs";
import { stageText } from "../lib/workstreamStage";
import type { WorkstreamView } from "../types";
import { Btn, SheetFrame, pickerOpen } from "./AgentSheet";
import { WorkstreamHeadExtras, rowTitle } from "./AgentsHome";
import { lightboxOpen } from "./PipImages";
import { popoverOpen } from "./Popover";
import { usePrefs } from "./prefs";
import { useRunSetup } from "./runSetupStore";
import { useRuns } from "./runsStore";
import { useTabs } from "./tabsStore";
import { isTypingTarget } from "./workKeys";
import { StepRail } from "./StepRail";
import { runDayAction } from "./StartMyDay";
import { NO_WORKSTREAM_ID, useWorkView, type WorkViewFocus } from "./workViewStore";
import { WorkstreamNeeds } from "./NeedsPane";
import { useNeedsYou } from "./useNeeds";
import { focusPip, useWorkstreams } from "./workstreamsStore";

export const WORKSTREAM_SHEET_ID = "workstream-sheet";

/**
 * The element in an open workstream's detail `target` names: a draft's card, a run's card, the held banner's Resume (the
 * banner itself without one), or the first choice on the card of a review that still blocks after the fix rounds.
 */
function targetElement(root: ParentNode, target: WorkViewFocus): HTMLElement | null {
  if (target.type === "escalation") return root.querySelector<HTMLElement>("[data-escalation] button") ?? root.querySelector<HTMLElement>("[data-escalation]");
  if (target.type === "workstream") return root.querySelector<HTMLElement>("[data-held-banner] button") ?? root.querySelector<HTMLElement>("[data-held-banner]");
  const attr = target.type === "draft" ? "data-draft" : "data-run-id";
  return root.querySelector<HTMLElement>(`[${attr}="${CSS.escape(target.id)}"]`);
}

/** About two seconds of frames: long enough for the steps to load, short enough that a stale ask doesn't linger. */
const FOCUS_FRAMES = 120;

/**
 * Brings the card something asked for (`focusTarget`) into view and focuses it once it renders, then clears it. A card that
 * isn't focusable by itself takes focus from code only.
 */
function useFocusTarget() {
  const target = useWorkView((s) => s.focusTarget);
  useEffect(() => {
    if (!target) return;
    let frame = 0;
    let tries = 0;
    const find = () => {
      const root = document.getElementById(WORKSTREAM_SHEET_ID);
      const el = root ? targetElement(root, target) : null;
      if (!el && ++tries < FOCUS_FRAMES) {
        frame = requestAnimationFrame(find);
        return;
      }
      if (el) {
        if (el.tabIndex < 0 && !el.hasAttribute("tabindex")) el.setAttribute("tabindex", "-1");
        el.scrollIntoView?.({ block: "nearest" });
        el.focus();
      }
      if (useWorkView.getState().focusTarget === target) useWorkView.getState().focus(null);
    };
    find();
    return () => cancelAnimationFrame(frame);
  }, [target]);
}

function Body({ view }: { view: WorkstreamView }) {
  const ws = view.workstream;
  const needs = useNeedsYou();
  useFocusTarget();
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <WorkstreamHeadExtras view={view} />
        <span data-stage className="text-sm text-ws-ink3">
          {stageText(view.stage, view.waitingForPr, view.reviewBlocking)}
        </span>
        <span className="flex-1" />
        {ws.itemKey && (
          <Btn tone="ghost" data-workstream-ticket onClick={() => runDayAction({ type: "ticket", key: ws.itemKey! })}>
            Open {ws.itemKey}
          </Btn>
        )}
        <Btn tone="teal" data-workstream-pip onClick={() => focusPip(ws.id)}>
          Ask Pip about this
        </Btn>
      </div>
      <WorkstreamNeeds key={`needs:${ws.id}`} needs={needs} workstreamId={ws.id} />
      <StepRail key={ws.id} view={view} />
    </>
  );
}

/** Esc closes the detail when nothing nearer has taken it: a run's sheet over it, a picker, a field, the peek, the palette. */
function useDetailEsc() {
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape" || ev.defaultPrevented || ev.metaKey || ev.ctrlKey || ev.altKey) return;
      const runs = useRuns.getState();
      if (runs.sheet !== null || runs.picking || useRunSetup.getState().open) return;
      const field = ev.target as HTMLElement | null;
      if (usePrefs.getState().paletteOpen || pickerOpen() || popoverOpen() || lightboxOpen() || useTabs.getState().selected !== null || isTypingTarget(field) || field?.closest?.("[data-esc-local]")) return;
      ev.preventDefault();
      useWorkView.getState().closeWorkstream();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

/**
 * An open workstream's detail, docked beside the Agents list: where it stands, its steps with their runs,
 * drafts and pull request, and its controls. The Pip drawer on the right keeps its own place and talks about this workstream.
 */
export function WorkstreamSheet({ id }: { id: string }) {
  if (id === NO_WORKSTREAM_ID) return <NoWorkstreamSheet />;
  return <OpenWorkstreamSheet id={id} />;
}

/** The detail of the runs and drafts that belong to no workstream: what they ask of the person, decided as in any workstream. */
function NoWorkstreamSheet() {
  const needs = useNeedsYou();
  useDetailEsc();
  useFocusTarget();
  return (
    <SheetFrame id={WORKSTREAM_SHEET_ID} docked label="No workstream" title="No workstream" hint="Agents and drafts that belong to no workstream" wide={false} min={420} onClose={() => useWorkView.getState().closeWorkstream()}>
      <WorkstreamNeeds needs={needs} workstreamId={null} />
      {needsIn(needs, null) === 0 && (
        <p data-no-workstream-empty className="m-0 text-sm text-ws-ink3">
          Nothing here needs you. Its agents are in the list, under No workstream.
        </p>
      )}
    </SheetFrame>
  );
}

function OpenWorkstreamSheet({ id }: { id: string }) {
  const view = useWorkstreams((s) => s.list.find((v) => v.workstream.id === id && v.workstream.closedAt === null));
  useDetailEsc();
  if (!view) return null;
  const ws = view.workstream;
  return (
    <SheetFrame id={WORKSTREAM_SHEET_ID} docked label={`Workstream ${ws.itemKey ?? ws.title}`} title={ws.itemKey ?? "Workstream"} hint={rowTitle(ws)} wide={false} min={420} onClose={() => useWorkView.getState().closeWorkstream()} topOn={id}>
      <Body view={view} />
    </SheetFrame>
  );
}
