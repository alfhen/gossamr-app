import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { useClaude } from "../claudeStore";
import { isHeldByYou } from "../lib/workstreamHold";
import { stageText } from "../lib/workstreamStage";
import { answersOwed, byStatusRank, emptyFilterText, hintFor, STATUS_WORD, workstreamStatus, type StatusState, type WorkstreamStatus } from "../lib/workstreamStatus";
import { StatusPill } from "./StatusPill";
import { PlanMyWeek, ThisWeek } from "./PlanMyWeek";
import { isoWeek } from "../lib/planMyWeek";
import { witherClass } from "../lib/views";
import { witherTitle, type WorkstreamWither } from "../lib/workstreamWither";
import { Cobweb } from "../components/Cobweb";
import { useWorkstreamWithers } from "./useWorkstreamWithers";
import type { Run, WorkstreamView } from "../types";
import { PipAvatar } from "./PipAvatar";
import { Composer, GENERAL_CONVERSATION, PIP_INPUT_ID, useAnswering, workstreamConversation } from "./PipConversation";
import { TimelineView } from "./Timeline";
import { TIMELINE_ENTRY, timelineStop } from "./timelineKeys";
import { lightboxOpen, useAttachments, useFileDrop } from "./PipImages";
import { ConversationLine, escapeCancelsTurn, useConversationDrafts, usePipChips } from "./PipPane";
import { popoverOpen } from "./Popover";
import { START_WORKSTREAM, focusLost } from "./commands";
import type { ClarityLearning } from "../lib/clarityLearning";
import { usePrefs } from "./prefs";
import { useRunSetup } from "./runSetupStore";
import { useTabs } from "./tabsStore";
import { needsIn, type Need } from "../lib/needs";
import { NeedsYouList } from "./NeedsYou";
import { useNeedsYou } from "./useNeeds";
import { nudgeOffered } from "../lib/reporterWait";
import { useWorkspace } from "../workspaceStore";
import { NeedsPane, paneStop } from "./NeedsPane";
import { StartMyDayCard } from "./StartMyDay";
import { arm, confirmArmed, disarm, groupId, keyPlan, openNeed, sayOpenNote, setPaneIntent } from "./needsActions";
import { undoLatest } from "./undo";
import { liveCounts } from "./agentsLogic";
import { composerFooter, landingSelection } from "./pipHomeLogic";
import { focusToast } from "./ToastHost";
import { PIP_HOME_REGIONS, columnRegion, regionColumn, usePipHome, type PipHomeColumn, type PipHomeFocus, type PipHomeRegion } from "./pipHomeStore";
import { useRuns } from "./runsStore";
import { focusComposer, focusedConversation, useHomeWorkstream, useWorkstreams } from "./workstreamsStore";
import { NOTICE, TABBABLE, pipHomeKey, wrapTab, type PipHomeItemKind } from "./pipHomeKeys";
import { InlineStartContext } from "./InlineStart";
import { StepRail } from "./StepRail";
import { useNow } from "./AgentsView";
import { pipHomeHints } from "./footerHints";
import { ShortcutHint } from "./ShortcutHint";
import { ORIENTATION_WORDS, PipOrientation } from "./PipOrientation";
import { DecisionShownContext, decisionShown } from "./decisionShown";

const PIP_HOME_HINTS = pipHomeHints();
const NEEDS_HINTS = pipHomeHints(true);
const TIMELINE_HINTS = pipHomeHints(false, true);

/** How long after Pip home opens it may still land on the top need's workstream: the stores are loading until then. */
const LANDING_MS = 5000;

/** The ticket's key comes first on its own, so the title loses it when it starts with it, as a workstream's title does. */
export function rowTitle(ws: WorkstreamView["workstream"]): string {
  const key = ws.itemKey;
  return key && ws.title.startsWith(key) ? ws.title.slice(key.length).trim() || ws.title : ws.title;
}

const ROW = "grid w-full gap-0.5 rounded-lg px-2.5 py-1.5 text-left outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-[-2px] focus-visible:outline-ws-pip";

/** A row's stage, then its one short detail ("3d", "Build") after the status pill, and "nudge due" once the reporter has been silent for days. */
function RowStatus({ status, view, nudge = false }: { status: WorkstreamStatus; view: WorkstreamView; nudge?: boolean }) {
  const stage = stageText(view.stage, view.waitingForPr, view.reviewBlocking);
  return (
    <span className="flex min-w-0 gap-1 text-xs text-ws-ink3">
      <span data-stage className="shrink-0">
        {stage}
      </span>
      {status.detail && (
        <span data-status-detail data-workstream-wither-short={status.state === "quiet" ? "" : undefined} className="min-w-0 truncate">
          · {status.detail}
        </span>
      )}
      {/* The reporter has been silent for days: the Next line (and Start my day) offer "Draft a nudge". */}
      {nudge && (
        <span data-nudge-due className="shrink-0">
          · nudge due
        </span>
      )}
    </span>
  );
}

/** A workstream row's name: its key and title, then its status word and detail ("DEVOPS-490 Fix login, Idle, may be unclear"). */
export const optionName = (...parts: (string | null | undefined)[]) => parts.filter(Boolean).join(", ");

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
  /** The workstreams that have gone quiet in Jira while work went on, by id (`useWorkstreamWithers`): each row gets its cobweb. */
  wither?: Readonly<Record<string, WorkstreamWither>>;
  /** The workstreams (by id) whose reporter has been silent long enough that a nudge is offered: their row says so. */
  nudgeDue?: ReadonlySet<string>;
  /** Only the workstreams in this state are listed; null lists every one. */
  statusFilter?: StatusState | null;
  onStatusFilter?(state: StatusState | null): void;
  /** The clock for each row's status; the time of the call when absent. */
  now?: number;
  /** What "Looks fine" taught the clarity notice (a row says "may be unclear" only for a gap still flagged); the prefs' when absent. */
  learning?: ClarityLearning;
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

/**
 * The workstreams, in a compact section under Needs you in Pip home's left column: General pinned at the top, then each
 * open workstream with where it stands; the closed ones behind a toggle, read-only. It takes at most 45% of the column and
 * scrolls inside that, so Needs you keeps the rest.
 */
export function WorkstreamList({ list, closed, showClosed, selected, onSelect, onShowClosed, runs = [], needsYou = [], wither = {}, nudgeDue, statusFilter = null, onStatusFilter, now, learning: given }: WorkstreamListProps) {
  const stored = usePrefs((s) => s.clarityLearning);
  const learning = given ?? stored;
  const events = useWorkstreams((s) => s.events);
  const drafts = useWorkspace((s) => s.proposals);
  const statuses = new Map(list.filter((v) => v.workstream.closedAt === null).map((v) => [v.workstream.id, workstreamStatus(v, needsYou, { runs, wither: wither[v.workstream.id] ?? null, now: new Date(now ?? Date.now()), learning, answersOwed: answersOwed(v.workstream.id, events[v.workstream.id], Object.values(drafts)) })]));
  // Ordered by what needs the person, not newest first: the rows are what j/k and the arrows step through.
  const everyOpen = byStatusRank(list.filter((v) => v.workstream.closedAt === null), (v) => statuses.get(v.workstream.id)!.state, (v) => isHeldByYou(v.workstream.heldReason));
  const matches = (v: WorkstreamView) => !statusFilter || statuses.get(v.workstream.id)?.state === statusFilter;
  // The open workstream stays listed when the filter leaves it out (dimmed, with a note), since its conversation is what is shown.
  const open = everyOpen.filter((v) => matches(v) || v.workstream.id === selected);
  const matching = everyOpen.filter(matches).length;
  // The live runs no workstream owns are General's, which the Running filter does not list: the empty text says so.
  const owned = new Set(list.flatMap((v) => v.runs));
  const generalRunning = liveCounts(runs.filter((r) => !owned.has(r.id) && !r.spec.workstream), now ?? Date.now()).running;
  const [listRef, more] = useMoreBelow<HTMLUListElement>();
  const hints = useId();
  const option = (id: string | null, label: string, describedBy?: string, level: WorkstreamWither["level"] = 0, dim = false) => ({
    role: "option" as const,
    "aria-selected": selected === id,
    tabIndex: selected === id ? 0 : -1,
    // The name is the short line j and k read; the sentence that explains the status is its description.
    "aria-label": label,
    "aria-describedby": describedBy,
    onClick: () => onSelect(id),
    className: `${ROW} ${selected === id ? "bg-ws-sel text-ws-ink" : "text-ws-ink2 hover:bg-ws-hover"} ${witherClass(level, "ws-")} ${dim ? "opacity-60" : ""}`.trim(),
  });
  return (
    <nav aria-label="Your workstreams" tabIndex={-1} className="flex min-h-0 flex-1 flex-col border-t border-ws-sep bg-ws-bar">
      <h2 className="m-0 px-3 pt-2 pb-1 text-xs font-semibold tracking-wide text-ws-ink3 uppercase">Workstreams</h2>
      <ul ref={listRef} role="listbox" aria-label="Open workstreams" aria-keyshortcuts="j k ArrowDown ArrowUp Enter" className="m-0 grid min-h-0 list-none content-start gap-0.5 overflow-y-auto p-0 px-1.5">
        <li data-workstream-row="general" {...option(null, optionName("General", needsIn(needsYou, null) > 0 ? `${needsIn(needsYou, null)} in Needs you` : null))}>
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="font-semibold text-ws-ink">General</span>
            <NeedsBadge count={needsIn(needsYou, null)} total={needsYou.length} />
          </span>
          <span className="text-xs text-ws-ink3">Everything not in a workstream</span>
        </li>
        {open.map((v) => {
          const web = wither[v.workstream.id];
          const status = statuses.get(v.workstream.id)!;
          return (
            <li key={v.workstream.id} data-workstream-row={v.workstream.id} data-wither={web ? web.level : undefined} data-filtered-out={matches(v) ? undefined : "" } title={web ? witherTitle(web) : undefined} {...option(v.workstream.id, optionName(`${v.workstream.itemKey ? `${v.workstream.itemKey} ` : ""}${rowTitle(v.workstream)}`, status.word, status.detail), web ? `${hints}-${v.workstream.id} ${hints}-${v.workstream.id}-web` : `${hints}-${v.workstream.id}`, web?.level, !matches(v))}>
              {web && <Cobweb level={web.level} />}
              <span className="flex min-w-0 items-center gap-1.5">
                {v.workstream.itemKey && <b className="shrink-0 font-mono font-semibold text-ws-ink">{v.workstream.itemKey}</b>}
                <span className="min-w-0 truncate">{rowTitle(v.workstream)}</span>
                <span className="ml-auto flex shrink-0">
                  <StatusPill status={status} hintId={`${hints}-${v.workstream.id}`} title={status.state === "needs-you" ? `${needsIn(needsYou, v.workstream.id)} of the ${needsYou.length} in Needs you ${needsIn(needsYou, v.workstream.id) === 1 ? "is" : "are"} here. ${hintFor(status)}` : undefined} />
                </span>
              </span>
              <RowStatus status={status} view={v} nudge={nudgeDue?.has(v.workstream.id)} />
              {!matches(v) && statusFilter && (
                <span data-filter-shown className="text-xs text-ws-ink3">
                  Shown because it is open; not {STATUS_WORD[statusFilter]}
                </span>
              )}
              {/* After the row's own words, so its name still starts with the ticket's key. */}
              {web && (
                <span data-workstream-wither id={`${hints}-${v.workstream.id}-web`} className="sr-only">
                  {web.text}
                </span>
              )}
            </li>
          );
        })}
      </ul>
      {more && (
        <p data-list-more aria-hidden="true" className="m-0 border-t border-ws-sep/60 bg-ws-bar px-3 py-0.5 text-center text-xs text-ws-ink3">
          More below ↓
        </p>
      )}
      {statusFilter && (
        <p data-status-filter={statusFilter} className="m-0 flex items-baseline gap-2 px-3 pb-1 text-xs text-ws-ink2">
          <span>
            Showing {STATUS_WORD[statusFilter]}: {matching}
          </span>
          <button type="button" onClick={() => onStatusFilter?.(null)} className="rounded px-1 text-ws-ink2 underline hover:bg-ws-hover focus-visible:outline-2 focus-visible:outline-ws-pip">
            Show all
          </button>
        </p>
      )}
      {matching === 0 && <p className="m-0 px-3 py-2 text-sm text-ws-ink3">{statusFilter ? emptyFilterText(statusFilter, generalRunning) : NO_WORKSTREAMS}</p>}
      <div className="mt-auto flex flex-wrap items-center gap-x-1 border-t border-ws-sep px-1.5 py-1">
        <button
          type="button"
          // The palette, already asking for a workstream: the person types the ticket, and its 'Start a workstream on' starts it.
          onClick={() => usePrefs.getState().setPaletteOpen(true, START_WORKSTREAM)}
          className="rounded px-2 py-0.5 text-left text-sm text-ws-ink2 hover:bg-ws-hover focus-visible:outline-2 focus-visible:outline-ws-pip"
        >
          Start a workstream…
        </button>
        <button
          type="button"
          aria-pressed={showClosed}
          onClick={() => onShowClosed(!showClosed)}
          className="rounded px-2 py-0.5 text-left text-sm text-ws-ink2 hover:bg-ws-hover focus-visible:outline-2 focus-visible:outline-ws-pip"
        >
          {showClosed ? "Hide closed" : "Show closed"}
        </button>
        {showClosed && (
          <ul aria-label="Closed workstreams" className="m-0 grid max-h-[min(30vh,12rem)] min-h-16 w-full list-none content-start gap-0.5 overflow-y-auto p-0">
            {closed.map((v) => {
              const key = v.workstream.itemKey;
              // The backend refuses a reopen while the ticket has another open workstream: say so instead of pressing a button that does nothing.
              const blocked = key ? everyOpen.some((o) => o.workstream.itemKey === key) : false;
              return (
                <li key={v.workstream.id} data-closed-workstream={v.workstream.id} className="grid gap-0.5 px-2.5 py-1 text-sm text-ws-ink3">
                  <span className="flex min-w-0 gap-1.5">
                    {key && <b className="shrink-0 font-mono font-semibold">{key}</b>}
                    <span className="min-w-0 truncate">{rowTitle(v.workstream)}</span>
                  </span>
                  <span className="flex flex-wrap items-baseline gap-x-2 text-xs">
                    Closed
                    <button
                      type="button"
                      data-reopen-workstream={v.workstream.id}
                      aria-label={`Reopen ${key ?? rowTitle(v.workstream)}`}
                      aria-disabled={blocked || undefined}
                      aria-describedby={blocked ? `reopen-blocked-${v.workstream.id}` : undefined}
                      onClick={() => !blocked && void useWorkstreams.getState().reopen(v.workstream.id)}
                      className={`rounded px-1 font-medium underline focus-visible:outline-2 focus-visible:outline-ws-pip ${blocked ? "cursor-not-allowed text-ws-ink3" : "text-ws-ink2 hover:bg-ws-hover"}`}
                    >
                      Reopen
                    </button>
                    {blocked && (
                      <span id={`reopen-blocked-${v.workstream.id}`} data-reopen-blocked>
                        {key} already has an open workstream
                      </span>
                    )}
                  </span>
                </li>
              );
            })}
            {closed.length === 0 && <li className="px-2.5 py-1 text-sm text-ws-ink3">No closed workstreams.</li>}
          </ul>
        )}
      </div>
    </nav>
  );
}

/**
 * After Cmd/Ctrl+0 opened General, the workstream's rail (and what had the keyboard in it) is gone: on the next frame, if the
 * keyboard fell to the page, it goes to the selected General row, where F6 and j/k carry on.
 */
export function settleGeneralFocus() {
  requestAnimationFrame(() => {
    if (!focusLost(document.activeElement, document.body)) return;
    document.querySelector<HTMLElement>('[data-pip-home] [data-workstream-row="general"]')?.focus();
  });
}

/** Whether the person asked for less motion: the fade's scroll then jumps instead of gliding. */
const reducedMotion = () => !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/** How far, and how, the fade scrolls a box `clientHeight` tall: most of a page, gliding unless the person asked for less motion. */
export const fadeScroll = (clientHeight: number, reduced: boolean): ScrollToOptions => ({ top: clientHeight * 0.8, behavior: reduced ? "auto" : "smooth" });

/** Whether a scroller with these measures has more below what shows (a few pixels of slack are not more). */
export const hasMoreBelow = (el: Pick<HTMLElement, "scrollHeight" | "scrollTop" | "clientHeight">) => el.scrollHeight - el.scrollTop - el.clientHeight > 4;

/** Whether the scroller on `ref` has more below what shows, kept up to date as it scrolls and resizes. */
export function useMoreBelow<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [more, setMore] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setMore(hasMoreBelow(el));
    measure();
    el.addEventListener("scroll", measure, { passive: true });
    const watch = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    watch?.observe(el);
    for (const c of Array.from(el.children)) watch?.observe(c);
    return () => (el.removeEventListener("scroll", measure), watch?.disconnect());
  });
  return [ref, more] as const;
}

/**
 * The F6 stop above the conversation that holds Start my day or Plan my week: a labelled region that scrolls when the card is
 * taller than its share (a third of the window at most, or nearly half for Plan my week, whose three picks should show, so the timeline and an open decision keep their room; with nothing in the conversation below to keep room for (`roomy`) Start my day takes most of it, so its lines show without scrolling), with a fade at the foot while something is cut off, so the scroll is not hidden.
 */
export const DAY_CAP = { start: "max-h-[30vh]", tall: "max-h-[min(45vh,26rem)]", roomy: "max-h-[min(60vh,34rem)]" } as const;

export function DayScroll({ label, children, tall = false, roomy = false }: { label: string; children: ReactNode; tall?: boolean; roomy?: boolean }) {
  const [box, more] = useMoreBelow<HTMLDivElement>();
  return (
    // Focusable so the keyboard can scroll it when it overflows: a scroller with no focusable child is out of the arrow keys' reach.
    <div ref={box} data-pip-home-day role="region" aria-label={label} tabIndex={0} className={`relative ${tall ? DAY_CAP.tall : roomy ? DAY_CAP.roomy : DAY_CAP.start} shrink-0 overflow-y-auto border-b border-ws-sep/60 outline-none empty:hidden focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ws-pip`}>
      {children}
      {more && (
        <div data-day-fade aria-hidden="true" onClick={() => box.current?.scrollBy(fadeScroll(box.current.clientHeight, reducedMotion()))} className="sticky bottom-0 -mt-7 cursor-pointer bg-gradient-to-t from-ws-bar via-ws-bar/90 to-transparent pt-4 pb-0.5 text-center text-xs text-ws-ink3">
          More below ↓
        </div>
      )}
    </div>
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
export function HomeConversation({ workstream, footer = null, pane = null, needs = [], day = null }: { workstream: WorkstreamView | null; footer?: string | null; pane?: ReactNode; needs?: readonly Need[]; day?: ReactNode }) {
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
      {day}
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
        paneOpen: usePipHome.getState().deciding !== null || usePipHome.getState().batch !== null,
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

/** The items j and k step through in the left column (the Needs you list's rows, then the workstreams') and in the step rail (its chips, and the cards under the open ones). */
export const COLUMN_ITEMS: Record<Exclude<PipHomeColumn, "conversation">, string> = {
  // An open group's own row is its top need's; that need's row under it is not a second stop (`data-needs-top`).
  list: '[data-pip-home-column="list"] [role="option"], [data-pip-home-column="list"] [data-needs-you-group], [data-pip-home-column="list"] [data-needs-you-need]:not([data-needs-top])',
  // The workstream's controls (Manage, Hold, Close) come first on the rail, as they sit above its steps.
  rail: '[data-pip-home-column="rail"] [data-workstream-controls] [role="switch"][aria-label="Manage this workstream"], [data-pip-home-column="rail"] [data-workstream-controls] [data-ws-hold], [data-pip-home-column="rail"] [data-workstream-controls] [data-close-workstream], [data-pip-home-column="rail"] [data-step-chip], [data-pip-home-column="rail"] article[data-run-id], [data-pip-home-column="rail"] article[data-draft]',
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

/** What puts each of F6's regions on screen. The decision pane exists only while one is open, the step rail only while a workstream gives it steps. */
const REGION_ON: Record<PipHomeRegion, string> = {
  needs: "[data-pip-home] [data-needs-you]",
  week: "[data-pip-home] [data-this-week]",
  workstreams: '[data-pip-home] nav[aria-label="Your workstreams"]',
  day: "[data-pip-home] [data-plan-my-week], [data-pip-home] [data-start-my-day]",
  notice: `[data-pip-home] ${NOTICE}`,
  timeline: "[data-pip-home] [data-timeline]",
  pane: "[data-pip-home] [data-needs-pane]",
  rail: '[data-pip-home-column="rail"] [data-step-rail]',
  composer: `#${PIP_INPUT_ID}`,
  toast: "[data-toast]",
};

const regionsOnScreen = () => PIP_HOME_REGIONS.filter((r) => document.querySelector(REGION_ON[r]));

/** The region of Pip home `el` is in; null for nothing there (focus on the page itself). The timeline's filter bar and the conversation's header are the timeline's. */
function regionOf(el: Element | null): PipHomeRegion | null {
  // The toast sits over the page, outside Pip home's columns.
  if (el?.closest("[data-toast]")) return "toast";
  if (!el || !el.closest("[data-pip-home]")) return null;
  if (el.closest("[data-needs-pane]")) return "pane";
  if (el.closest("[data-plan-my-week], [data-start-my-day]")) return "day";
  if (el.closest("[data-needs-you]")) return "needs";
  if (el.closest(NOTICE)) return "notice";
  if (el.closest("[data-this-week]")) return "week";
  if (el.closest('nav[aria-label="Your workstreams"]')) return "workstreams";
  if (el.closest('[data-pip-home-column="rail"]')) return "rail";
  if (el.id === PIP_INPUT_ID) return "composer";
  if (el.closest("[data-timeline-scope-shown], [data-pip-home-column=\"conversation\"] > section > header")) return "timeline";
  // Anything else in the conversation column is the composer's: its attachments, its commands.
  return el.closest('[data-pip-home-column="conversation"]') ? "composer" : el.closest('[data-pip-home-column="list"]') ? "workstreams" : null;
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
 * Pip home's keyboard, as `pipHomeKey` decides: F6 or Cmd/Ctrl+] and [ move between the regions (Needs you, the workstreams, the timeline, the open decision, the steps, the
 * composer), wrapping; in the left column and the rail j and k (or the arrows) step and Enter or Space opens or toggles. It listens after everything nearer the
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
    /** F6's stops: where the keyboard lands in a region, which is the first row of Needs you, the selected workstream, the newest entry of the timeline, the pane's heading, the rail as `enter` has it, or the composer. */
    const enterRegion = (region: PipHomeRegion) => {
      if (region === "rail" || region === "composer") return enter(regionColumn(region));
      if (region === "toast") return void focusToast();
      usePipHome.getState().setColumn(regionColumn(region));
      const home = document.querySelector("[data-pip-home]");
      const all = (sel: string) => Array.from(home?.querySelectorAll<HTMLElement>(sel) ?? []);
      switch (region) {
        case "needs": {
          const rows = all("[data-needs-you-group]");
          return void show(rows.find((r) => r.getAttribute("aria-current") === "true") ?? rows[0] ?? home?.querySelector<HTMLElement>("[data-needs-you-title]"));
        }
        case "week":
          return void show(home?.querySelector<HTMLElement>("[data-this-week-item] button") ?? home?.querySelector<HTMLElement>("[data-this-week-edit]") ?? home?.querySelector<HTMLElement>("[data-this-week]"));
        case "workstreams": {
          const rows = all('[role="option"]');
          return void show(rows.find((r) => r.getAttribute("aria-selected") === "true") ?? rows[0] ?? home?.querySelector<HTMLElement>('nav[aria-label="Your workstreams"]'));
        }
        case "day":
          return void show(home?.querySelector<HTMLElement>("[data-plan-my-week]") ?? home?.querySelector<HTMLElement>("[data-start-my-day]"));
        case "notice":
          return void show(home?.querySelector<HTMLElement>(`${NOTICE} button:not(:disabled)`) ?? home?.querySelector<HTMLElement>(NOTICE));
        case "timeline": {
          const last = all("[data-timeline] " + TIMELINE_ENTRY).pop();
          return void show(last ? timelineStop(last) : home?.querySelector<HTMLElement>("[data-timeline]"));
        }
        case "pane": {
          const pane = home?.querySelector<HTMLElement>("[data-needs-pane]");
          return void show(pane && paneStop(pane));
        }
      }
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
      const active = document.activeElement as HTMLElement | null;
      let at = list.indexOf(active as HTMLElement);
      // A group's top need, opened under its row, is that row's stop.
      if (at < 0 && active?.hasAttribute("data-needs-top")) at = list.findIndex((e) => e.hasAttribute("data-needs-you-group") && e.getAttribute("data-need-key") === active.getAttribute("data-need-key"));
      const home = usePipHome.getState();
      const el = list[at];
      const needKey = el?.getAttribute("data-need-key") ?? null;
      // Focus inside the open decision: its keys act on the need it shows, not on a row.
      const inPane = document.activeElement instanceof HTMLElement && document.activeElement.closest("[data-needs-pane]") !== null;
      const need = needKey ? needsRef.current.find((n) => n.key === needKey) : inPane && home.deciding ? needsRef.current.find((n) => n.key === home.deciding) : undefined;
      const action = pipHomeKey(ev, { column, overlay: overlayOpen(), count: list.length, at, kind: itemKind(el), region: regionOf(active) ?? columnRegion(column), regions: regionsOnScreen(), asking: !!home.asking && home.asking.key === needKey, pane: home.deciding !== null || home.batch !== null, inPane });
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
          sayOpenNote(plan);
          return openNeed(need, { edit: plan.edit });
        }
        case "undo": {
          // The toast offering it goes with it (`undoLog`'s settled hook).
          return undoLatest();
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
        case "region":
          return enterRegion(action.to);
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
 * Pip home: Needs you as the main left column with the workstreams in a compact section under it, the timeline and
 * composer of the selected workstream (or General) beside them, with the decision pane opening above the timeline, and
 * the steps. Below about 1100px the steps drop under the conversation.
 */
export function PipHome() {
  const list = useWorkstreams((s) => s.list);
  const closed = useWorkstreams((s) => s.closed);
  const loaded = useWorkstreams((s) => s.loaded);
  const selected = usePipHome((s) => s.selected);
  const showClosed = usePipHome((s) => s.showClosed);
  const statusFilter = usePipHome((s) => s.statusFilter);
  const planOpen = usePipHome((s) => s.planOpen);
  const workstream = useHomeWorkstream();
  // General with nothing said yet: the conversation under Start my day has nothing in it to keep room for.
  const quiet = useClaude((s) => (s.byTicket[GENERAL_CONVERSATION]?.turns.length ?? 0) === 0);
  const runs = useRuns((s) => s.runs);
  const needsYou = useNeedsYou();
  const deciding = usePipHome((s) => s.deciding);
  // What the decision pane shows is not shown again in the timeline or on the rail.
  const decided = useMemo(() => decisionShown(needsYou.find((n) => n.key === deciding), list), [needsYou, deciding, list]);
  // The same clock as the Agents view's, so a run gone quiet leaves "running" here when it does there.
  const now = useNow();
  const openList = useMemo(() => list.filter((v) => v.workstream.closedAt === null), [list]);
  const withers = useWorkstreamWithers(openList, now);
  const proposals = useWorkspace((s) => s.proposals);
  // Workstreams whose reporter has been silent long enough that the Next line and Start my day offer a nudge.
  const nudgeDue = useMemo(() => new Set(openList.filter((v) => nudgeOffered(v.waitingOnReporter, new Date(now), Object.values(proposals), v.workstream.id)).map((v) => v.workstream.id)), [openList, proposals, now]);
  const footer = useMemo(() => composerFooter(runs, needsYou.length, now), [runs, needsYou.length, now]);
  const orientationSeen = usePrefs((s) => s.pipOrientationSeen);
  // Once Got it is pressed the card is gone for good; the words stay one button away in the header, which brings the card back for now.
  const [wordsOpen, setWordsOpen] = useState(false);
  const wordsLink = useRef<HTMLButtonElement>(null);
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
  // The first load with nothing chosen lands on the workstream of the top need, so what needs the person is not a click away.
  const openIds = useMemo(() => openList.map((v) => v.workstream.id), [openList]);
  const mountedAt = useRef(Date.now());
  useEffect(() => {
    const home = usePipHome.getState();
    if (home.landed) return;
    // A need can arrive before the workstreams are read, its workstream not among `openIds` yet: landing then would give it up.
    if (!loaded) return;
    // Only while it loads: a need that turns up later never moves what the person is looking at.
    if (home.selected !== null || Date.now() - mountedAt.current > LANDING_MS) return home.land();
    const landing = landingSelection(needsYou, openIds);
    if (!landing) return;
    if (landing.id) home.openWorkstream(landing.id);
    else home.land();
  }, [needsYou, openIds, loaded]);
  useTurnEscape();
  useFocusTarget();
  usePipHomeKeys(needsYou);
  // The column the keyboard is in follows focus, however it got there.
  const enter = (column: PipHomeColumn) => () => {
    if (usePipHome.getState().column !== column) usePipHome.getState().setColumn(column);
  };
  return (
    <div data-pip-home className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 items-baseline gap-3 border-b border-ws-sep bg-ws-bar px-4 py-2">
        <h1 className="m-0 text-base font-semibold">Pip home</h1>
        <span className="min-w-0 truncate text-sm text-ws-ink3">What needs you, your workstreams, and what Pip and its agents are doing</span>
        {orientationSeen && (
          <button ref={wordsLink} type="button" data-orientation-link aria-expanded={wordsOpen} onClick={() => setWordsOpen(!wordsOpen)} className="ml-auto shrink-0 rounded-md px-2 text-sm text-ws-ink2 underline decoration-ws-sep2 underline-offset-2 hover:bg-ws-hover focus-visible:outline-2 focus-visible:outline-ws-pip">
            {ORIENTATION_WORDS}
          </button>
        )}
      </header>
      {!orientationSeen && <PipOrientation compact={planOpen} />}
      {orientationSeen && wordsOpen && <PipOrientation open compact={planOpen} onDismiss={() => (setWordsOpen(false), wordsLink.current?.focus())} />}
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(260px,340px)_minmax(0,1fr)] grid-rows-[minmax(0,1fr)_auto] overflow-hidden min-[1100px]:grid-cols-[minmax(280px,340px)_minmax(0,1fr)_minmax(240px,320px)] min-[1100px]:grid-rows-[minmax(0,1fr)]">
        <div data-pip-home-column="list" onFocusCapture={enter("list")} className="contents">
          {/* The left column: Needs you takes the height, the workstreams are a compact section under it. */}
          <div data-pip-home-left className="flex min-h-0 flex-col border-r border-ws-sep bg-ws-bar">
            <NeedsYouList main needs={needsYou} now={now} />
            <ThisWeek />
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
              wither={withers}
              nudgeDue={nudgeDue}
              statusFilter={statusFilter}
              onStatusFilter={(state) => usePipHome.getState().setStatusFilter(state)}
              now={now}
            />
          </div>
        </div>
        {/* Run drafts that need nothing chosen are read and started in place here, in the conversation and the rail alike. */}
        <InlineStartContext.Provider value={true}>
          <DecisionShownContext.Provider value={decided}>
            <div data-pip-home-column="conversation" onFocusCapture={enter("conversation")} className="contents">
              <HomeConversation workstream={workstream} footer={footer} needs={needsYou} day={
                  <DayScroll label={planOpen ? "Plan my week" : "Start my day"} tall={planOpen} roomy={quiet}>
                    {planOpen && <PlanMyWeek key={isoWeek(new Date(now))} needs={needsYou} withers={withers} now={now} />}
                    {/* The plan is opened from the card and its Close brings it back; the card is General's summary, not a workstream's. */}
                    {!planOpen && workstream === null && <StartMyDayCard needs={needsYou} withers={withers} now={now} />}
                  </DayScroll>
                } pane={<NeedsPane needs={needsYou} />} />
            </div>
            <div data-pip-home-column="rail" onFocusCapture={enter("rail")} className="contents">
              <StepsColumn workstream={workstream} />
            </div>
          </DecisionShownContext.Provider>
        </InlineStartContext.Provider>
      </div>
      <footer data-pip-home-hints className="@container flex h-8 shrink-0 items-center border-t border-ws-sep bg-ws-bar px-4 text-xs text-ws-ink3">
        <ShortcutHint view="list" hints={onNeed ? NEEDS_HINTS : onTimeline ? TIMELINE_HINTS : PIP_HOME_HINTS} />
      </footer>
    </div>
  );
}
