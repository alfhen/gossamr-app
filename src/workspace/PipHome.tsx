import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useClaude } from "../claudeStore";
import { stageText } from "../lib/workstreamStage";
import type { Run, WorkstreamView } from "../types";
import { PipAvatar } from "./PipAvatar";
import { Composer, GENERAL_CONVERSATION, PIP_INPUT_ID, useAnswering, workstreamConversation } from "./PipConversation";
import { TimelineView } from "./Timeline";
import { TIMELINE_ENTRY } from "./timelineKeys";
import { lightboxOpen, useAttachments, useFileDrop } from "./PipImages";
import { ConversationLine, escapeCancelsTurn, useConversationDrafts, usePipChips } from "./PipPane";
import { popoverOpen } from "./Popover";
import { START_WORKSTREAM } from "./commands";
import { usePrefs } from "./prefs";
import { useRunSetup } from "./runSetupStore";
import { useTabs } from "./tabsStore";
import { needsIn, type Need } from "../lib/needs";
import { NeedsYouList } from "./NeedsYou";
import { useNeedsYou } from "./useNeeds";
import { NeedsPane } from "./NeedsPane";
import { arm, confirmArmed, disarm, groupId, keyPlan, openNeed, setPaneIntent } from "./needsActions";
import { composerFooter, workstreamStatus } from "./pipHomeLogic";
import { usePipHome, type PipHomeColumn, type PipHomeFocus } from "./pipHomeStore";
import { useRuns } from "./runsStore";
import { focusComposer, focusedConversation, useHomeWorkstream, useWorkstreams } from "./workstreamsStore";
import { TABBABLE, pipHomeKey, wrapTab, type PipHomeItemKind } from "./pipHomeKeys";
import { InlineStartContext } from "./InlineStart";
import { StepRail } from "./StepRail";
import { useNow } from "./AgentsView";
import { pipHomeHints } from "./footerHints";
import { ShortcutHint } from "./ShortcutHint";
import { PipOrientation } from "./PipOrientation";

const PIP_HOME_HINTS = pipHomeHints();
const NEEDS_HINTS = pipHomeHints(true);
const TIMELINE_HINTS = pipHomeHints(false, true);

/** The ticket's key comes first on its own, so the title loses it when it starts with it, as a workstream's title does. */
export function rowTitle(ws: WorkstreamView["workstream"]): string {
  const key = ws.itemKey;
  return key && ws.title.startsWith(key) ? ws.title.slice(key.length).trim() || ws.title : ws.title;
}

const ROW = "grid w-full gap-0.5 rounded-lg px-2.5 py-1.5 text-left outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-[-2px] focus-visible:outline-ws-pip";

/** A row's stage, then its short status unless the stage already says it ("Build · waiting for PR"). */
function RowStatus({ view, runs, waiting }: { view: WorkstreamView; runs: readonly Run[]; waiting: number }) {
  const stage = stageText(view.stage, view.waitingForPr, view.reviewBlocking);
  const status = workstreamStatus(view, runs, waiting);
  return (
    <span className="flex min-w-0 gap-1 text-xs text-ws-ink3">
      <span data-stage className="shrink-0">
        {stage}
      </span>
      {!stage.endsWith(status) && (
        <span data-status className="min-w-0 truncate">
          · {status}
        </span>
      )}
    </span>
  );
}

export interface WorkstreamListProps {
  list: readonly WorkstreamView[];
  closed: readonly WorkstreamView[];
  showClosed: boolean;
  /** The workstream shown, by id; null is General. */
  selected: string | null;
  onSelect(id: string | null): void;
  onShowClosed(on: boolean): void;
  /** Every run, for each row's status. */
  runs?: readonly Run[];
  /** What waits on the person, for each row's count. */
  needsYou?: readonly Need[];
  /** The Needs you list, at the bottom of the column. */
  tray?: ReactNode;
}

/** What the list says before there is any workstream: what one is, in a line. */
export const NO_WORKSTREAMS = "No workstreams yet. A workstream follows one ticket from investigation to a reviewed pull request, with Pip keeping track.";

/** "1 needs you", "3 need you"; nothing when nothing does. Its row's share of the one count in Needs you (`total`), and its tooltip says so. */
function NeedsBadge({ count, total }: { count: number; total: number }) {
  if (!count) return null;
  return (
    <span data-needs-you-badge title={`${count} of the ${total} in Needs you ${count === 1 ? "is" : "are"} here`} className="ml-auto shrink-0 rounded-full bg-ws-pip px-1.5 text-[10px] leading-4 font-semibold text-ws-on-pip">
      {count} {count === 1 ? "needs" : "need"} you
    </span>
  );
}

/** Pip home's left column: General pinned at the top, then each open workstream with where it stands; the closed ones behind a toggle, read-only. */
export function WorkstreamList({ list, closed, showClosed, selected, onSelect, onShowClosed, runs = [], needsYou = [], tray }: WorkstreamListProps) {
  const open = list.filter((v) => v.workstream.closedAt === null);
  const option = (id: string | null) => ({
    role: "option" as const,
    "aria-selected": selected === id,
    tabIndex: selected === id ? 0 : -1,
    onClick: () => onSelect(id),
    className: `${ROW} ${selected === id ? "bg-ws-sel text-ws-ink" : "text-ws-ink2 hover:bg-ws-hover"}`,
  });
  return (
    <nav aria-label="Workstreams" tabIndex={-1} className="flex min-h-0 flex-col border-r border-ws-sep bg-ws-bar">
      <h2 className="m-0 px-3 pt-3 pb-1.5 text-xs font-semibold tracking-wide text-ws-ink3 uppercase">Workstreams</h2>
      <ul role="listbox" aria-label="Workstreams" aria-keyshortcuts="j k ArrowDown ArrowUp Enter" className="m-0 grid min-h-0 list-none content-start gap-0.5 overflow-y-auto p-0 px-1.5">
        <li data-workstream-row="general" {...option(null)}>
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="font-semibold text-ws-ink">General</span>
            <NeedsBadge count={needsIn(needsYou, null)} total={needsYou.length} />
          </span>
          <span className="text-xs text-ws-ink3">Everything not in a workstream</span>
        </li>
        {open.map((v) => (
          <li key={v.workstream.id} data-workstream-row={v.workstream.id} {...option(v.workstream.id)}>
            <span className="flex min-w-0 items-center gap-1.5">
              {v.workstream.itemKey && <b className="shrink-0 font-mono font-semibold text-ws-ink">{v.workstream.itemKey}</b>}
              <span className="min-w-0 truncate">{rowTitle(v.workstream)}</span>
              <NeedsBadge count={needsIn(needsYou, v.workstream.id)} total={needsYou.length} />
            </span>
            <RowStatus view={v} runs={runs} waiting={needsIn(needsYou, v.workstream.id)} />
          </li>
        ))}
      </ul>
      {open.length === 0 && <p className="m-0 px-3 py-2 text-sm text-ws-ink3">{NO_WORKSTREAMS}</p>}
      <div className="mt-auto grid gap-1 border-t border-ws-sep px-1.5 py-2">
        <button
          type="button"
          // The palette, already asking for a workstream: the person types the ticket, and its 'Start a workstream on' starts it.
          onClick={() => usePrefs.getState().setPaletteOpen(true, START_WORKSTREAM)}
          className="rounded px-2 py-1 text-left text-sm text-ws-ink2 hover:bg-ws-hover focus-visible:outline-2 focus-visible:outline-ws-pip"
        >
          Start a workstream…
        </button>
        <button
          type="button"
          aria-pressed={showClosed}
          onClick={() => onShowClosed(!showClosed)}
          className="rounded px-2 py-1 text-left text-sm text-ws-ink2 hover:bg-ws-hover focus-visible:outline-2 focus-visible:outline-ws-pip"
        >
          {showClosed ? "Hide closed" : "Show closed"}
        </button>
        {showClosed && (
          <ul aria-label="Closed workstreams" className="m-0 grid max-h-[30vh] list-none gap-0.5 overflow-y-auto p-0">
            {closed.map((v) => (
              <li key={v.workstream.id} data-closed-workstream={v.workstream.id} className="grid gap-0.5 px-2.5 py-1 text-sm text-ws-ink3">
                <span className="flex min-w-0 gap-1.5">
                  {v.workstream.itemKey && <b className="shrink-0 font-mono font-semibold">{v.workstream.itemKey}</b>}
                  <span className="min-w-0 truncate">{rowTitle(v.workstream)}</span>
                </span>
                <span className="text-xs">Closed</span>
              </li>
            ))}
            {closed.length === 0 && <li className="px-2.5 py-1 text-sm text-ws-ink3">No closed workstreams.</li>}
          </ul>
        )}
        {tray}
      </div>
    </nav>
  );
}

/** The right column: the selected workstream's step rail, or a word for General. */
export function StepsColumn({ workstream }: { workstream: WorkstreamView | null }) {
  return (
    <aside
      aria-label="Steps"
      className="col-span-2 grid max-h-[40vh] min-h-0 content-start gap-3 overflow-y-auto border-t border-ws-sep bg-ws-bar px-3 py-3 min-[1100px]:col-span-1 min-[1100px]:max-h-none min-[1100px]:border-t-0 min-[1100px]:border-l"
      tabIndex={-1}
    >
      <h2 className="m-0 text-xs font-semibold tracking-wide text-ws-ink3 uppercase">Steps</h2>
      {workstream ? <StepRail key={workstream.workstream.id} view={workstream} /> : <p className="m-0 text-sm text-ws-ink3">Pick a workstream to see its steps.</p>}
    </aside>
  );
}

/**
 * The conversation column of Pip home: the workstream's timeline (its conversation with Pip, its runs, drafts and audit in
 * one list) over the same composer the Pip pane has.
 */
export function HomeConversation({ workstream, footer = null, pane = null, needs = [] }: { workstream: WorkstreamView | null; footer?: string | null; pane?: ReactNode; needs?: readonly Need[] }) {
  const conversation = workstream ? workstreamConversation(workstream.workstream.id) : GENERAL_CONVERSATION;
  const running = useAnswering(conversation);
  const attached = useAttachments();
  const drop = useFileDrop((files) => void attached.add(files));
  const proposals = useConversationDrafts(conversation, workstream);
  const { chips, primary, scene, label } = usePipChips(workstream);
  return (
    <section aria-label="Conversation" data-pip-root {...drop.handlers} className="relative flex min-h-0 min-w-0 flex-col bg-ws-win">
      {drop.over && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-2 z-10 grid place-items-center rounded-xl border-2 border-dashed border-ws-pip bg-ws-pip-soft text-center font-semibold text-ws-pip"
        >
          Drop an image to show Pip
        </div>
      )}
      <header className="grid gap-1.5 border-b border-ws-sep bg-ws-bar px-3 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <PipAvatar size={22} thinking={running} />
          <ConversationLine conversation={conversation} workstream={workstream} />
        </div>
      </header>
      {pane}
      <TimelineView key={conversation} conversation={conversation} workstream={workstream} proposals={proposals} needs={needs} primary={primary} />
      <Composer conversation={conversation} attached={attached} chips={chips} looking={label} scene={scene} footer={footer} />
    </section>
  );
}

/**
 * The element on Pip home `target` names: a draft's card, a run's card, the held banner's Resume (the banner itself
 * without one), or the first choice on the card of a review that still blocks after the fix rounds.
 */
function targetElement(root: ParentNode, target: PipHomeFocus): HTMLElement | null {
  if (target.type === "escalation") return root.querySelector<HTMLElement>("[data-escalation] button") ?? root.querySelector<HTMLElement>("[data-escalation]");
  if (target.type === "workstream") return root.querySelector<HTMLElement>("[data-held-banner] button") ?? root.querySelector<HTMLElement>("[data-held-banner]");
  const attr = target.type === "draft" ? "data-draft" : "data-run-id";
  const sel = `[${attr}="${CSS.escape(target.id)}"]`;
  // A run asked for on the rail is its card there, once its step has opened; with no rail on screen (General), any card of it.
  if (target.type === "run" && target.where === "rail" && root.querySelector("[data-step-rail]")) return root.querySelector<HTMLElement>(`[data-step-rail] ${sel}`);
  return root.querySelector<HTMLElement>(sel);
}

/** About two seconds of frames: long enough for a conversation to load, short enough that a stale ask doesn't linger. */
const FOCUS_FRAMES = 120;

/**
 * Brings Pip home's focus target into view and focuses it once it renders (the conversation may still be loading), then
 * clears it. A card that isn't focusable by itself takes focus from code only.
 */
function useFocusTarget() {
  const target = usePipHome((s) => s.focusTarget);
  useEffect(() => {
    if (!target) return;
    // What is asked for may be filtered out of the timeline: it shows everything again.
    if (usePipHome.getState().timelineFilter !== "all") usePipHome.getState().setTimelineFilter("all");
    // And it is in the selected workstream's own timeline.
    if (usePipHome.getState().timelineScope !== "workstream") usePipHome.getState().setTimelineScope("workstream");
    let frame = 0;
    let tries = 0;
    const find = () => {
      const root = document.querySelector("[data-pip-home]");
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
      if (usePipHome.getState().focusTarget === target) usePipHome.getState().focus(null);
    };
    find();
    return () => cancelAnimationFrame(frame);
  }, [target]);
}

/**
 * Esc on Pip home, as `escapeCancelsTurn` decides: registered when Pip home mounts, so before any sheet's own listener, it
 * sees a sheet, the peek, the palette, a popover or the lightbox still open and leaves Esc to them. With none open, Esc
 * stops Pip's answer in the focused conversation, from the composer too.
 */
function useTurnEscape() {
  useEffect(() => {
    const onKey = (ev: globalThis.KeyboardEvent) => {
      if (ev.key !== "Escape") return;
      const field = document.activeElement;
      const editable = field instanceof HTMLElement && (field.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(field.tagName));
      const runs = useRuns.getState();
      const conversation = focusedConversation();
      const cancel = escapeCancelsTurn({
        sheetOpen: useRunSetup.getState().open || runs.sheet !== null || runs.picking || document.querySelector('[aria-modal="true"]') !== null,
        peekOpen: useTabs.getState().selected !== null,
        paletteOpen: usePrefs.getState().paletteOpen,
        popoverOpen: popoverOpen(),
        lightbox: lightboxOpen(),
        // An open Needs you decision closes first: the next Esc stops Pip.
        paneOpen: usePipHome.getState().deciding !== null,
        // A confirmation that takes Esc itself, or a field being edited other than Pip's own input.
        handled: ev.defaultPrevented || (field instanceof HTMLElement && !!field.closest("[data-esc-local]")) || (editable && field?.id !== PIP_INPUT_ID),
        running: (useClaude.getState().byTicket[conversation]?.turns ?? []).some((t) => t.status === "running"),
      });
      if (!cancel) return;
      ev.preventDefault();
      useClaude.getState().cancel(conversation);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
}

/** The items j and k step through in the workstream list (its rows, then the Needs you list's rows) and in the step rail (its chips, and the cards under the open ones). */
const COLUMN_ITEMS: Record<Exclude<PipHomeColumn, "conversation">, string> = {
  list: '[data-pip-home-column="list"] [role="option"], [data-pip-home-column="list"] [data-needs-you-group], [data-pip-home-column="list"] [data-needs-you-need]',
  rail: '[data-pip-home-column="rail"] [data-step-chip], [data-pip-home-column="rail"] article[data-run-id], [data-pip-home-column="rail"] article[data-draft]',
};

function itemKind(el: Element | undefined): PipHomeItemKind | null {
  if (!el) return null;
  if (el.matches('[role="option"]')) return "row";
  if (el.matches("[data-needs-you-group]")) return "group";
  if (el.matches("[data-needs-you-need]")) return "need";
  if (el.matches("[data-step-chip]")) return "chip";
  if (el.matches("article[data-run-id]")) return "run";
  return el.matches("article[data-draft]") ? "draft" : null;
}

/** Something over Pip home that takes the keys: the palette, the peek, a sheet, a popover, the lightbox or any other dialog. */
function overlayOpen(): boolean {
  const runs = useRuns.getState();
  return (
    usePrefs.getState().paletteOpen ||
    useTabs.getState().selected !== null ||
    useRunSetup.getState().open ||
    runs.sheet !== null ||
    runs.picking ||
    popoverOpen() ||
    lightboxOpen() ||
    document.querySelector('[role="dialog"], [aria-modal="true"]') !== null
  );
}

/** The page's Tab stops in order: enabled, shown and not taken out of the order. */
const tabStops = () =>
  Array.from(document.querySelectorAll<HTMLElement>(TABBABLE)).filter((el) => el.tabIndex >= 0 && !(el as HTMLButtonElement).disabled && !el.closest("[hidden], [inert]") && el.getClientRects().length > 0);

const show = (el: HTMLElement | null | undefined) => {
  if (!el) return false;
  el.scrollIntoView?.({ block: "nearest" });
  el.focus();
  return true;
};

/** Puts focus on the Needs you row of `need` (its group's while that is folded): where a decision's keys return to. */
function backToRow(need: Need) {
  const list = '[data-pip-home-column="list"]';
  const row = document.querySelector<HTMLElement>(`${list} [data-need-key="${CSS.escape(need.key)}"]`) ?? document.querySelector<HTMLElement>(`${list} [data-needs-you-group="${CSS.escape(groupId(need.workstreamId))}"]`);
  row?.focus();
}

/**
 * Pip home's keyboard, as `pipHomeKey` decides: F6 or Cmd/Ctrl+] and [ move between the columns, wrapping; in the list
 * and the rail j and k (or the arrows) step and Enter or Space opens or toggles. It listens after everything nearer the
 * key, so a card, a confirmation or a sheet that took the key keeps it.
 */
function usePipHomeKeys(needsYou: readonly Need[]) {
  const needsRef = useRef(needsYou);
  needsRef.current = needsYou;
  /** The rail item focused last, so coming back to the rail lands where the person left it. */
  const lastRail = useRef<HTMLElement | null>(null);
  useEffect(() => {
    /** The step that item was in. */
    let lastStep: string | null = null;
    const items = (column: PipHomeColumn) => (column === "conversation" ? [] : Array.from(document.querySelectorAll<HTMLElement>(COLUMN_ITEMS[column])));
    const onFocus = (ev: FocusEvent) => {
      // A key of the Needs you list that asked for Enter is dropped once the keyboard goes anywhere else.
      const asking = usePipHome.getState().asking;
      if (asking && !(ev.target instanceof HTMLElement && ev.target.getAttribute("data-need-key") === asking.key)) disarm();
      if (!(ev.target instanceof HTMLElement) || !ev.target.closest('[data-pip-home-column="rail"]') || !ev.target.matches(COLUMN_ITEMS.rail)) return;
      lastRail.current = ev.target;
      lastStep = ev.target.closest("[data-step]")?.getAttribute("data-step") ?? null;
    };
    const enter = (column: PipHomeColumn, near: string | null = lastStep) => {
      usePipHome.getState().setColumn(column);
      if (column === "conversation") return focusComposer();
      const list = items(column);
      // On the rail, where the person left it; that card gone (decided, say), its step's chip.
      const step = near ? list.find((el) => el.getAttribute("data-step-chip") === near) : undefined;
      const current = column === "list" ? (list.find((el) => el.getAttribute("aria-selected") === "true") ?? list[0]) : lastRail.current?.isConnected ? lastRail.current : (step ?? list[0]);
      // A column with nothing to step through takes focus itself.
      if (!show(current)) show(document.querySelector<HTMLElement>(`[data-pip-home-column="${column}"] > *`));
    };
    const onKey = (ev: globalThis.KeyboardEvent) => {
      if (ev.defaultPrevented) return;
      if (ev.key === "Tab") {
        const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        const round = wrapTab(ev, tabStops(), active, !!active?.closest("[data-pip-home]"));
        if (round) {
          ev.preventDefault();
          round.focus();
        }
        return;
      }
      const column = usePipHome.getState().column;
      const list = items(column);
      const at = list.indexOf(document.activeElement as HTMLElement);
      const steps = document.querySelector('[data-pip-home-column="rail"] [data-step-rail]') !== null;
      const home = usePipHome.getState();
      const el = list[at];
      const needKey = el?.getAttribute("data-need-key") ?? null;
      // Focus inside the open decision: its keys act on the need it shows, not on a row.
      const inPane = document.activeElement instanceof HTMLElement && document.activeElement.closest("[data-needs-pane]") !== null;
      const need = needKey ? needsRef.current.find((n) => n.key === needKey) : inPane && home.deciding ? needsRef.current.find((n) => n.key === home.deciding) : undefined;
      const action = pipHomeKey(ev, { column, overlay: overlayOpen(), count: list.length, at, kind: itemKind(el), steps, asking: !!home.asking && home.asking.key === needKey, pane: home.deciding !== null, inPane });
      if (!action) return;
      ev.preventDefault();
      switch (action.type) {
        case "decide":
          if (!need) return;
          // A group opens with everything it holds listed, and its highest-ranked need decided.
          if (itemKind(el) === "group" && Number(el.getAttribute("data-needs-count")) > 1) home.setExpanded(groupId(need.workstreamId), true);
          return openNeed(need);
        case "collapse": {
          if (!need) return;
          const gid = groupId(need.workstreamId);
          home.setExpanded(gid, false);
          return void requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-pip-home-column="list"] [data-needs-you-group="${CSS.escape(gid)}"]`)?.focus());
        }
        case "act": {
          const plan = need ? keyPlan(need, action.act) : null;
          if (!need || !plan) return;
          // From inside the decision the row is where Enter confirms, so the keyboard goes back to it first.
          if (plan.type === "ask") return setPaneIntent(null), inPane && backToRow(need), arm(need, plan);
          // Skipping or dismissing acts at once and offers Undo; the row keeps the keyboard, or hands it on as it leaves.
          if (plan.type === "do") return setPaneIntent(null), plan.run();
          return openNeed(need, { edit: plan.edit });
        }
        case "confirm":
          return confirmArmed();
        case "cancel":
          return disarm();
        case "closePane": {
          const back = inPane ? need : undefined;
          home.closeDecision();
          return void (back && backToRow(back));
        }
        case "column":
          return enter(action.to);
        case "focus":
          return void show(list[action.index]);
        case "toggle":
          return el?.click();
        case "open":
          if (!el) return;
          if (itemKind(el) === "run") return el.querySelector<HTMLElement>("[data-run-open]")?.click();
          el.click();
          // A row opens its conversation: the keyboard follows it there.
          if (itemKind(el) === "row") enter("conversation");
      }
    };
    // The peek opened over Pip home (as a ticket draft's action opens it) hands the keyboard back when it closes: to what
    // had focus when it opened, or, once that has gone (a draft decided in the peek), to the column's current row or chip.
    let opener: { el: Element | null; column: PipHomeColumn; step: string | null } | null = null;
    const offPeek = useTabs.subscribe((s, was) => {
      if (s.selected === was.selected) return;
      if (s.selected !== null && was.selected === null) opener = { el: document.activeElement, column: usePipHome.getState().column, step: document.activeElement?.closest("[data-step]")?.getAttribute("data-step") ?? null };
      else if (s.selected === null && opener) {
        const back = opener;
        opener = null;
        requestAnimationFrame(() => {
          // Focus still in the peek, as it may be while the peek slides out, is as good as lost.
          const at = document.activeElement;
          if (useTabs.getState().route !== "pip" || (at && at !== document.body && !at.closest("#peek-sheet"))) return;
          if (back.el instanceof HTMLElement && back.el.isConnected) back.el.focus();
          else if (back.column === "rail" && back.step) {
            lastRail.current = null;
            enter("rail", back.step);
          } else enter(back.column);
        });
      }
    });
    window.addEventListener("keydown", onKey);
    document.addEventListener("focusin", onFocus);
    return () => {
      offPeek();
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("focusin", onFocus);
    };
  }, []);
}

/**
 * Pip home: the workstreams, the conversation with Pip in the selected one (or General), and its steps. Below about
 * 1100px the steps drop under the conversation.
 */
export function PipHome() {
  const list = useWorkstreams((s) => s.list);
  const closed = useWorkstreams((s) => s.closed);
  const selected = usePipHome((s) => s.selected);
  const showClosed = usePipHome((s) => s.showClosed);
  const workstream = useHomeWorkstream();
  const runs = useRuns((s) => s.runs);
  const needsYou = useNeedsYou();
  // The same clock as the Agents view's, so a run gone quiet leaves "running" here when it does there.
  const now = useNow();
  const footer = useMemo(() => composerFooter(runs, needsYou.length, now), [runs, needsYou.length, now]);
  const orientationSeen = usePrefs((s) => s.pipOrientationSeen);
  // The footer names the list's own keys while the keyboard is on one of its rows.
  const [onNeed, setOnNeed] = useState(false);
  // And the timeline's while it is on one of its entries.
  const [onTimeline, setOnTimeline] = useState(false);
  useEffect(() => {
    const on = () => {
      setOnNeed(!!document.activeElement?.closest("[data-needs-you-group], [data-needs-you-need]"));
      setOnTimeline(!!document.activeElement?.closest(TIMELINE_ENTRY));
    };
    document.addEventListener("focusin", on);
    document.addEventListener("focusout", on);
    return () => {
      document.removeEventListener("focusin", on);
      document.removeEventListener("focusout", on);
    };
  }, []);
  useTurnEscape();
  useFocusTarget();
  usePipHomeKeys(needsYou);
  // The column the keyboard is in follows focus, however it got there.
  const enter = (column: PipHomeColumn) => () => {
    if (usePipHome.getState().column !== column) usePipHome.getState().setColumn(column);
  };
  return (
    <div data-pip-home className="flex h-full min-h-0 flex-col">
      {!orientationSeen && <PipOrientation />}
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(180px,250px)_minmax(0,1fr)] grid-rows-[minmax(0,1fr)_auto] overflow-hidden min-[1100px]:grid-cols-[minmax(200px,260px)_minmax(0,1fr)_minmax(240px,320px)] min-[1100px]:grid-rows-[minmax(0,1fr)]">
        <div data-pip-home-column="list" onFocusCapture={enter("list")} className="contents">
          <WorkstreamList
            list={list}
            closed={closed}
            showClosed={showClosed}
            selected={workstream ? selected : null}
            onSelect={(id) => (id ? usePipHome.getState().openWorkstream(id) : usePipHome.getState().openGeneral())}
            onShowClosed={(on) => {
              usePipHome.getState().setShowClosed(on);
              if (on) void useWorkstreams.getState().loadClosed();
            }}
            runs={runs}
            needsYou={needsYou}
            tray={<NeedsYouList needs={needsYou} now={now} />}
          />
        </div>
        {/* Run drafts that need nothing chosen are read and started in place here, in the conversation and the rail alike. */}
        <InlineStartContext.Provider value={true}>
          <div data-pip-home-column="conversation" onFocusCapture={enter("conversation")} className="contents">
            <HomeConversation workstream={workstream} footer={footer} needs={needsYou} pane={<NeedsPane needs={needsYou} />} />
          </div>
          <div data-pip-home-column="rail" onFocusCapture={enter("rail")} className="contents">
            <StepsColumn workstream={workstream} />
          </div>
        </InlineStartContext.Provider>
      </div>
      <footer data-pip-home-hints className="@container flex h-8 shrink-0 items-center border-t border-ws-sep bg-ws-bar px-4 text-xs text-ws-ink3">
        <ShortcutHint view="list" hints={onNeed ? NEEDS_HINTS : onTimeline ? TIMELINE_HINTS : PIP_HOME_HINTS} />
      </footer>
    </div>
  );
}
