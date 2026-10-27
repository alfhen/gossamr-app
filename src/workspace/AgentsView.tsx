import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { isArchivable } from "../lib/archiveRuns";
import { itemKey } from "../lib/filter";
import type { Need } from "../lib/needs";
import { labelsByRun, stageText } from "../lib/workstreamStage";
import type { ReviewView, Run, WorkstreamView } from "../types";
import { useWorkspace } from "../workspaceStore";
import { AgentCard, agentId, type AgentItemProps } from "./AgentCard";
import { Icon } from "./AgentIcons";
import { AgentRow, AgentRowHeader } from "./AgentRow";
import { ArchivedSection } from "./ArchivedSection";
import { ClearFinished } from "./ClearFinished";
import { AgentsBanners } from "./AgentsBanners";
import { AgentsEmpty, AgentsIntro, NoMatch } from "./AgentsEmpty";
import {
  AGENTS_GROUPS,
  ALL,
  CHIPS,
  CHIP_LABEL,
  LANES,
  LANE_IDS,
  activeChip,
  agentGroups,
  chipCounts,
  chipFilters,
  filterOptions,
  isFiltered,
  laneCount,
  laneIsFolded,
  navOrder,
  stepRun,
  slotWaiters,
  stopAllText,
  stoppable,
  liveSummary,
  needsScope,
  type AgentFilters,
  type Chip,
  type NeedsScope,
  type AgentsGroup,
  type LaneGroup,
  type LaneId,
  type WorkstreamGroup,
} from "./agentsLogic";
import { useFooterHeight } from "./CanvasFooter";
import { failureAction } from "./failureActions";
import type { FailureAct } from "./failureHelp";
import { AGENTS_VIEWS, usePrefs, type AgentsViewMode } from "./prefs";
import { useBuildChanges, useReviewVerdicts } from "./reviewVerdicts";
import { showDraft as showTicketDraft } from "./draftTicket";
import { RESUME_TEXT, breakdownTarget, buildFromPlanControl, commentControl, pipAsks, reviewThisControl, resumable, runBreakdownDraftOf, runDescriptionDraftOf, runDraftOf, runTicketDraftOf, shownVerdict } from "./runSheetLogic";
import { setNoticeOpener, useRuns } from "./runsStore";
import { askPipInWorkstream } from "./askPip";
import { focusPip, useWorkstreams } from "./workstreamsStore";
import { stableGroups } from "./stableOrder";
import { useNow } from "./useNow";
import { agentKey } from "./agentKeys";
import { ClosedWorkstreams, DecisionScope, NeedsBadge, WorkstreamHeadExtras, WorkstreamTools, rowTitle } from "./AgentsHome";
import { WorkstreamSheet } from "./WorkstreamSheet";
import { arm, confirmArmed, disarm, keyPlan, openNeed, openRunOrNeed } from "./needsActions";
import { isTypingTarget } from "./workKeys";
import { undoLatest } from "./undo";
import { NO_WORKSTREAM_ID, useWorkView } from "./workViewStore";
import { currentNeeds, useNeedsYou } from "./useNeeds";
import { needsIn } from "../lib/needs";

const KBD = "font-sans text-[11px] rounded border border-ws-sep2 bg-ws-bar px-1";
const BUTTON = "inline-flex items-center gap-1.5 rounded-md border border-ws-sep2 px-2.5 py-px text-sm leading-normal whitespace-nowrap hover:bg-ws-hover disabled:cursor-not-allowed disabled:opacity-45";
const VIEW_LABEL: Record<AgentsViewMode, string> = { cards: "Cards", list: "List" };
const GROUP_LABEL: Record<AgentsGroup, string> = { state: "State", workstream: "Workstream" };

export { useNow };

// A notification or nudge for a run that needs the person opens its need; runsStore cannot import needsActions without a cycle.
setNoticeOpener(openRunOrNeed, () => needsScope(currentNeeds()));

const NO_WORKSTREAMS: readonly WorkstreamView[] = [];

export type KeyAction = { type: "select"; id: string } | { type: "clear" };

/** What j, k and Esc do on the list; null when the key is not ours or there is nothing to do. */
export function keyAction(key: string, current: string | null, order: readonly string[]): KeyAction | null {
  if (key === "j" || key === "k") {
    const id = stepRun(order, current, key === "j" ? 1 : -1);
    return id ? { type: "select", id } : null;
  }
  return key === "Escape" && current ? { type: "clear" } : null;
}

/** Stop all, with `count` agents working or waiting on the person and `waiting` approved runs waiting for a slot. */
export function StopAll({ count, waiting = 0, busy, onStop }: { count: number; waiting?: number; busy: boolean; onStop(): void }) {
  const [asking, setAsking] = useState(false);
  const none = count + waiting === 0;
  useEffect(() => {
    if (none) setAsking(false);
  }, [none]);
  if (!asking) {
    return (
      <button type="button" disabled={none || busy} title="Stop every agent that is working or waiting" onClick={() => setAsking(true)} className={`${BUTTON} border-ws-blocked text-ws-blocked hover:bg-ws-blocked hover:text-white`}>
        <Icon name="stop" />
        Stop all
      </button>
    );
  }
  return (
    <span
      role="group"
      aria-label="Stop all agents"
      onKeyDown={(ev) => {
        if (ev.key === "Escape") {
          ev.stopPropagation();
          setAsking(false);
        }
      }}
      className="inline-flex flex-wrap items-center gap-2"
    >
      <span className="text-sm text-ws-ink2">
        Stop {stopAllText(count, waiting)}? Their work is kept. Agents from Terminal are not touched.
      </span>
      <button type="button" autoFocus onClick={() => (setAsking(false), onStop())} className={`${BUTTON} border-ws-blocked bg-ws-blocked font-semibold text-white`}>
        Yes, stop all
      </button>
      <button type="button" onClick={() => setAsking(false)} className={BUTTON}>
        Keep going
      </button>
    </span>
  );
}

function Select({ label, all, value, options, onChange }: { label: string; all: string; value: string; options: [string, string][]; onChange(v: string): void }) {
  return (
    <select aria-label={`Filter by ${label}`} data-set={value !== ALL ? "" : undefined} value={value} onChange={(ev) => onChange(ev.target.value)} className="ws-select">
      <option value={ALL}>{all}</option>
      {options.map(([v, text]) => (
        <option key={v} value={v}>
          {text}
        </option>
      ))}
    </select>
  );
}

export interface AgentsActions {
  select(id: string | null): void;
  open(id: string): void;
  attach(id: string): void;
  draftComment(id: string): void;
  buildFromPlan(run: Run): void;
  /** Resumes a run stopped at its limit, the one way it carries on. */
  resume(id: string): void;
  /** Shows the comment draft a finished run left on its ticket. */
  openDraft?(run: Run): void;
  openBreakdown?(run: Run): void;
  openDescription?(run: Run): void;
  filter(patch: Partial<AgentFilters>): void;
  clearFilters(): void;
  setView(view: AgentsViewMode): void;
  setGroup(group: AgentsGroup): void;
  toggleEarlier(): void;
  archive?(id: string): void;
  setIntro(open: boolean): void;
  dismissIntro(): void;
  retry(): void;
  /** The step a failed launch needs: Terminal, or the install page. */
  fix(id: string, act: FailureAct): void;
  retryLaunch(id: string): void;
  copied(id: string): void;
  stopAll(): void;
  askPip(): void;
  openSafety(): void;
  /** Opens a need's decision at the top of its workstream's detail, from a run's "In Needs you" pill. */
  openNeed?(need: Need): void;
  /** Opens a workstream's detail. */
  openWorkstream?(id: string): void;
}

/** The summary as filters: Needs you, Ready to review, Failed or stuck and All, each a toggle, with what is running said beside them. */
function SummaryChips({ runs, now, needsYou, filters, group, on }: { runs: readonly Run[]; now: number; needsYou: number; filters: AgentFilters; group: AgentsGroup; on: AgentsActions }) {
  const counts = chipCounts(runs, now, needsYou);
  const active = activeChip(filters);
  const live = liveSummary(runs, now);
  const choose = (chip: Chip) => {
    // Pressing the chip that is on goes back to All.
    const next = chip === active ? "all" : chip;
    if (next === "needs" && group !== "workstream") on.setGroup("workstream");
    on.filter(chipFilters(next));
  };
  return (
    <div role="group" aria-label="Show" data-summary-chips className="flex flex-wrap items-center gap-1.5">
      {CHIPS.map((chip) => {
        const n = chip === "all" ? null : counts[chip];
        // A lane chip with nothing behind it is not offered, unless it is the one that is on; Needs you always says its number.
        if (n === 0 && chip !== active && chip !== "needs") return null;
        return (
          <button
            key={chip}
            type="button"
            data-chip={chip}
            aria-pressed={active === chip}
            onClick={() => choose(chip)}
            className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-px text-sm leading-normal whitespace-nowrap focus-visible:outline-2 focus-visible:outline-ws-pip ${active === chip ? "border-ws-pip bg-ws-pip font-semibold text-ws-on-pip" : chip === "needs" ? "border-ws-pip text-ws-ink hover:bg-ws-hover" : "border-ws-sep2 text-ws-ink2 hover:bg-ws-hover"}`}
          >
            {CHIP_LABEL[chip]}
            {n !== null && (
              <span data-chip-count data-needs-you-count={chip === "needs" ? "" : undefined} className="font-semibold">
                {n}
              </span>
            )}
            {chip === "needs" && n === 0 && <span className="sr-only">Nothing needs you.</span>}
          </button>
        );
      })}
      {(live || (!runs.length && !needsYou)) && (
        <span aria-live="polite" className="text-sm text-ws-ink3">
          {live || "Nothing running"}
        </span>
      )}
    </div>
  );
}

function Toolbar({ runs, filters, view, group, introShown, tools, on }: { runs: readonly Run[]; filters: AgentFilters; view: AgentsViewMode; group: AgentsGroup; introShown: boolean; tools?: ReactNode; on: AgentsActions }) {
  const { repos, tickets } = useMemo(() => filterOptions(runs), [runs]);
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-ws-sep px-6 py-1.5">
      <div role="group" aria-label="Layout" className="inline-flex gap-0.5 rounded-[7px] border border-ws-sep2 p-0.5">
        {AGENTS_VIEWS.map((v) => (
          <button
            key={v}
            type="button"
            aria-pressed={view === v}
            onClick={() => on.setView(v)}
            className={`inline-flex items-center gap-1.5 rounded-[5px] px-2 py-px text-sm ${view === v ? "bg-ws-sel font-semibold text-ws-ink" : "text-ws-ink2 hover:bg-ws-hover"}`}
          >
            <Icon name={v === "cards" ? "grid" : "list"} />
            {VIEW_LABEL[v]}
          </button>
        ))}
      </div>
      <span className="inline-flex items-center gap-1.5 text-sm text-ws-ink3">
        Group by
        <span role="group" aria-label="Group by" className="inline-flex gap-0.5 rounded-[7px] border border-ws-sep2 p-0.5">
          {AGENTS_GROUPS.map((g) => (
            <button
              key={g}
              type="button"
              aria-pressed={group === g}
              onClick={() => on.setGroup(g)}
              className={`rounded-[5px] px-2 py-px text-sm ${group === g ? "bg-ws-sel font-semibold text-ws-ink" : "text-ws-ink2 hover:bg-ws-hover"}`}
            >
              {GROUP_LABEL[g]}
            </button>
          ))}
        </span>
      </span>
      <Select label="state" all="All states" value={filters.lane} options={LANE_IDS.map((l) => [l, LANES[l].title])} onChange={(v) => on.filter({ lane: v as LaneId | "all" })} />
      <Select label="repo" all="All repos" value={filters.repo} options={repos.map((r) => [r, r])} onChange={(v) => on.filter({ repo: v })} />
      <Select label="ticket" all="All tickets" value={filters.ticket} options={tickets.map((t) => [t, t])} onChange={(v) => on.filter({ ticket: v })} />
      {isFiltered(filters) && (
        <button type="button" onClick={on.clearFilters} className="rounded-md px-2 py-px text-sm text-ws-ink2 hover:bg-ws-hover">
          Clear
        </button>
      )}
      <span className="flex-1" />
      {tools}
      <button type="button" aria-pressed={introShown} onClick={() => on.setIntro(!introShown)} className="inline-flex items-center gap-1.5 rounded-md px-2 py-px text-sm text-ws-ink2 hover:bg-ws-hover">
        <Icon name="info" />
        How agents work
      </button>
    </div>
  );
}

function Lane({ group, now, folded, onToggle, children }: { group: LaneGroup; now: number; folded: boolean; onToggle?: () => void; children: ReactNode }) {
  return (
    <section aria-label={group.title} data-lane={group.lane} className="grid gap-2.5">
      <div className="flex items-center gap-2">
        <h3 className="m-0 text-xs font-semibold tracking-[0.05em] uppercase text-ws-ink2">{group.title}</h3>
        <span data-lane-count className="text-xs text-ws-ink3">
          {laneCount(group.lane, group.runs, now)}
        </span>
        <span className="ml-1 text-sm text-ws-ink3">{group.why}</span>
        {onToggle && (
          <button type="button" aria-expanded={!folded} onClick={onToggle} className="ml-auto rounded-md px-2 py-px text-sm text-ws-ink2 hover:bg-ws-hover">
            {folded ? "Show" : "Hide"}
          </button>
        )}
      </div>
      {!folded && children}
    </section>
  );
}

/** A workstream's runs in the Agents view, under its title and the stage they give it; its detail opens from the heading. */
function WorkstreamSection({ group, view, current, onOpen, children }: { group: WorkstreamGroup; view?: WorkstreamView; current: boolean; onOpen?(id: string): void; children: ReactNode }) {
  const needs = useNeedsYou();
  const mine = needsIn(needs, group.id);
  const openId = group.id ?? (mine ? NO_WORKSTREAM_ID : null);
  const title = group.itemKey ? rowTitle({ itemKey: group.itemKey, title: group.title }) : group.title;
  const name = group.itemKey ? `${group.itemKey} ${title}` : title;
  return (
    <section aria-label={group.title} data-workstream-group={group.id ?? "none"} data-has-needs={mine ? "" : undefined} aria-current={current || undefined} className={`relative grid gap-2.5 ${mine ? "-ml-3 rounded-sm border-l-[3px] border-ws-pip pl-2.5" : ""}`}>
      <div className="flex min-w-0 items-center gap-2">
        {group.id && (
          <span aria-hidden className="text-ws-pip">
            ◆
          </span>
        )}
        <h3 className={`m-0 flex min-w-0 items-baseline gap-1.5 truncate text-sm font-semibold ${group.id ? "text-ws-ink" : "text-ws-ink2"}`}>
          {group.itemKey ? (
            <>
              <b className="shrink-0 font-mono font-semibold">{group.itemKey}</b>
              <span className="min-w-0 truncate">{title}</span>
            </>
          ) : (
            group.title
          )}
        </h3>
        {group.stage && (
          <span data-stage={group.stage} data-waiting-for-pr={group.waitingForPr || undefined} className="shrink-0 rounded-full bg-ws-pip-soft px-2 text-xs font-semibold text-ws-pip">
            {stageText(group.stage, group.waitingForPr, group.reviewBlocking)}
          </span>
        )}
        {view ? <WorkstreamHeadExtras view={view} /> : <NeedsBadge count={mine} total={needs.length} />}
        <span className="text-xs text-ws-ink3">{group.runs.length}</span>
        {openId && onOpen && (
          <button type="button" data-workstream-open={openId} aria-label={group.id ? `Open workstream ${name}` : `Open ${group.title}`} aria-expanded={current} onClick={() => onOpen(openId)} className="ml-auto shrink-0 rounded-md px-2 py-px text-sm font-semibold text-ws-accent hover:bg-ws-hover focus-visible:outline-2 focus-visible:outline-ws-pip">
            Open
          </button>
        )}
      </div>
      {children}
    </section>
  );
}

export interface AgentsScreenProps {
  runs: readonly Run[];
  status: "idle" | "loading" | "ready" | "error";
  error: string | null;
  filters: AgentFilters;
  selectedId: string | null;
  earlierOpen: boolean;
  introShown: boolean;
  view: AgentsViewMode;
  /** How runs are grouped; by workstream when absent. */
  group?: AgentsGroup;
  /** The open workstreams, for their titles and where they stand when grouped by workstream. */
  workstreams?: readonly WorkstreamView[];
  /** The workstream whose detail is open, if any. */
  openWorkstream?: string | null;
  /** Which runs and workstreams hold a need, for the Needs you filter. */
  needed?: NeedsScope;
  /** A workstream's detail, docked beside the list. */
  side?: ReactNode;
  /** What the toolbar adds for workstreams: starting one, and the closed ones. */
  tools?: ReactNode;
  /** The closed workstreams, when they are asked for. */
  closedSection?: ReactNode;
  stopping: boolean;
  /** Where "Clear finished…" goes in the header; it needs the stores, so the connected view passes it. */
  clear?: ReactNode;
  archivedSection?: ReactNode;
  /** Failed runs the person has taken the Terminal step for. */
  opened: ReadonlySet<string>;
  /** How many things need the person, as Needs you counts them (the rail badge and the composer say the same). */
  needsYou?: number;
  /** The runs that are one of those things, by run id, with the need's key; each shows an "In Needs you" pill that opens it. */
  inNeeds?: ReadonlyMap<string, Need>;
  /** The key press in Needs you's list or here that waits for Enter, shown on its run's card. */
  asking?: { key: string; text: string } | null;
  now: number;
  ticketTitle(run: Run): string | null;
  /** Whether a finished run has a comment draft waiting. */
  draftReady?(run: Run): boolean;
  /** Whether a finished run has a breakdown into subtasks waiting. */
  breakdownReady?(run: Run): boolean;
  descriptionReady?(run: Run): boolean;
  /** What "Review this" does for a finished build whose pull request can be reviewed; absent for any other run. */
  reviewThis?(run: Run): (() => void) | undefined;
  /** A finished review's verdict, once its outcome is read; null for a review that gave none, absent for any other run. */
  reviewOf?(run: Run): ReviewView | null | undefined;
  on: AgentsActions;
  /** Told the order j and k walk the runs in, as shown, which a list the person is engaged with keeps from re-sorting. */
  onOrder?(order: string[]): void;
}

/** The whole screen as a function of its state; `AgentsView` connects it to the stores. */
export function AgentsScreen({ runs, status, error, filters, selectedId, earlierOpen, introShown, view, group = "workstream", workstreams = NO_WORKSTREAMS, openWorkstream = null, needed, tools, closedSection, side, stopping, clear, archivedSection, opened, needsYou, inNeeds, asking, now, ticketTitle, draftReady, breakdownReady, descriptionReady, reviewThis, reviewOf, on, onOrder }: AgentsScreenProps) {
  const footer = useFooterHeight();
  // While the pointer is over the list or focus is in it, cards keep their places; the normal sort applies once both leave.
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const frozen = hovered || focused;
  const sorted = useMemo(() => agentGroups(group, runs, workstreams, filters, earlierOpen, now, needed), [group, runs, workstreams, filters, earlierOpen, now, needed]);
  const shownBefore = useRef<{ group: AgentsGroup; lanes: LaneGroup[] | null; workstreams: WorkstreamGroup[] | null } | null>(null);
  const { lanes, workstreams: wsGroups, order } = useMemo(() => {
    const before = shownBefore.current?.group === group ? shownBefore.current : null;
    if (!frozen || !before) return sorted;
    const lanes = sorted.lanes && stableGroups(before.lanes ?? [], sorted.lanes, true, (g) => g.lane);
    const workstreams = sorted.workstreams && stableGroups(before.workstreams ?? [], sorted.workstreams, true, (g) => g.id ?? "none");
    return { lanes, workstreams, order: navOrder((lanes ?? workstreams) as readonly { runs: readonly Run[]; lane?: LaneId }[], earlierOpen, filters) };
  }, [sorted, frozen, group, earlierOpen, filters]);
  // Recorded once committed, so a render React discards never becomes the order the next frozen render keeps.
  useLayoutEffect(() => {
    shownBefore.current = { group, lanes, workstreams: wsGroups };
  }, [group, lanes, wsGroups]);
  // Published in the commit, not after paint: j and k read this from a native window listener, which a passive effect can trail by one event.
  useLayoutEffect(() => onOrder?.(order), [order, onOrder]);
  const filtered = isFiltered(filters);
  // A workstream with no run yet is a group too, so the list is not empty while one exists.
  const shown = (lanes ?? wsGroups ?? []).reduce((n, g) => n + g.runs.length, 0) + (wsGroups?.filter((g) => g.runs.length === 0).length ?? 0);
  // A run's short name in its workstream shows in the lanes too, as it does in the conversation that uses it.
  const labels = useMemo(() => Object.fromEntries(labelsByRun(runs)), [runs]);

  const props = (run: Run, at: number, label?: string): AgentItemProps => ({
    run,
    now,
    selected: selectedId === run.id,
    position: at,
    total: order.length,
    ticketTitle: ticketTitle(run),
    label,
    onOpen: () => on.open(run.id),
    onAttach: () => on.attach(run.id),
    draftReady: !!draftReady?.(run),
    breakdownReady: !!breakdownReady?.(run),
    onOpenDraft: on.openDraft ? () => on.openDraft?.(run) : undefined,
    onOpenBreakdown: on.openBreakdown ? () => on.openBreakdown?.(run) : undefined,
    descriptionReady: !!descriptionReady?.(run),
    onOpenDescription: on.openDescription ? () => on.openDescription?.(run) : undefined,
    onBuildFromPlan: buildFromPlanControl(run).enabled ? () => on.buildFromPlan(run) : undefined,
    onResume: resumable(run) ? () => on.resume(run.id) : undefined,
    onArchive: on.archive && isArchivable(run) ? () => on.archive?.(run.id) : undefined,
    onReviewThis: reviewThis?.(run),
    review: reviewOf?.(run),
    onDraftComment: run.state === "done" && commentControl(run).enabled ? () => on.draftComment(run.id) : undefined,
    onOpenNeed: inNeeds?.has(run.id) ? () => on.openNeed?.(inNeeds.get(run.id)!) : undefined,
    asking: asking && inNeeds?.get(run.id)?.key === asking.key ? asking.text : undefined,
    failure: { opened: opened.has(run.id), on: { act: (act) => on.fix(run.id, act), retry: () => on.retryLaunch(run.id), copied: () => on.copied(run.id) } },
  });

  let position = 0;
  /** A group's runs as rows or cards, whichever the layout is. */
  const items = (title: string, list: readonly Run[], header: boolean, labels: Record<string, string> = {}) =>
    view === "list" ? (
      <div role="group" aria-label={title} className="overflow-hidden rounded-[10px] border border-ws-sep">
        {header && <AgentRowHeader />}
        {list.map((r) => (
          <AgentRow key={r.id} {...props(r, ++position, labels[r.id])} />
        ))}
      </div>
    ) : (
      <div role="group" aria-label={title} className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,340px),1fr))] gap-3">
        {list.map((r) => (
          <AgentCard key={r.id} {...props(r, ++position, labels[r.id])} />
        ))}
      </div>
    );
  const title = useRef<HTMLHeadingElement>(null);
  const root = useRef<HTMLDivElement>(null);
  // The screen opens from the rail or the palette, which leave the keyboard in Pip's composer: a frame later the heading takes it, unless it is already inside the view.
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      if (!root.current?.contains(document.activeElement)) title.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, []);
  const waiting = status === "idle" || (status === "loading" && runs.length === 0);

  return (
    <div ref={root} data-agents-home className="flex h-full min-h-0">
    <div className="@container flex h-full min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-ws-sep bg-ws-bar px-6 py-2.5">
          <h1 ref={title} tabIndex={-1} className="m-0 rounded text-base font-semibold focus-visible:outline-2 focus-visible:outline-ws-pip">
            Agents
          </h1>
          <SummaryChips runs={runs} now={now} needsYou={needsYou ?? 0} filters={filters} group={group} on={on} />
          <span className="flex-1" />
          <button type="button" onClick={on.askPip} className={`${BUTTON} border-ws-pip bg-ws-pip font-semibold text-ws-on-pip hover:bg-ws-pip hover:brightness-110`}>
            <Icon name="spark" />
            Ask Pip
          </button>
          <button type="button" onClick={on.openSafety} className={BUTTON}>
            <Icon name="shield" />
            Safety and settings
          </button>
          {clear}
          <StopAll count={stoppable(runs).length} waiting={slotWaiters(runs).length} busy={stopping} onStop={on.stopAll} />
        </header>
        <Toolbar runs={runs} filters={filters} view={view} group={group} introShown={introShown} tools={tools} on={on} />
        <div className="min-h-0 flex-1 overflow-y-auto pt-5 pr-[max(24px,var(--ws-launcher-gutter,0px))] pb-[max(80px,var(--ws-launcher-clear,0px))] pl-6">
          <div
            data-agents-list
            data-frozen={frozen || undefined}
            onPointerEnter={() => setHovered(true)}
            onPointerLeave={() => setHovered(false)}
            onFocus={() => setFocused(true)}
            onBlur={(ev) => setFocused(!!ev.relatedTarget && ev.currentTarget.contains(ev.relatedTarget as Node))}
            className="grid gap-5.5"
          >
            <AgentsBanners loadError={status === "error" ? error : null} onRetry={on.retry} />
            {introShown && <AgentsIntro onDismiss={on.dismissIntro} />}
            {waiting ? (
              <p role="status" className="m-0 py-10 text-center text-ws-ink3">
                Loading agents…
              </p>
            ) : runs.length === 0 && shown === 0 ? (
              !introShown && status !== "error" && <AgentsEmpty />
            ) : shown === 0 ? (
              <NoMatch hidden={runs.length} onClear={on.clearFilters} />
            ) : wsGroups ? (
              wsGroups.map((g, gi) => (
                <WorkstreamSection key={g.id ?? "none"} group={g} view={g.id ? workstreams.find((w) => w.workstream.id === g.id) : undefined} current={(g.id ?? NO_WORKSTREAM_ID) === openWorkstream} onOpen={on.openWorkstream}>
                  {g.runs.length ? items(g.title, g.runs, gi === 0, g.labels) : <p data-workstream-empty className="m-0 text-sm text-ws-ink3">{filters.needs ? "Open it to see what needs you." : "No agents on this workstream yet."}</p>}
                </WorkstreamSection>
              ))
            ) : (
              (lanes ?? []).map((g, gi) => (
                <Lane key={g.lane} group={g} now={now} folded={laneIsFolded(g.lane, earlierOpen, filters)} onToggle={g.lane === "earlier" && !filtered ? on.toggleEarlier : undefined}>
                  {items(g.title, g.runs, gi === 0, labels)}
                </Lane>
              ))
            )}
            {!waiting && closedSection}
            {!waiting && archivedSection}
          </div>
        </div>
        <footer ref={footer} className="@container flex h-8 shrink-0 items-center gap-4 border-t border-ws-sep bg-ws-win px-6 text-xs text-ws-ink3">
          <p className="m-0 min-w-0 flex-1 truncate">
            <kbd className={KBD}>j</kbd> <kbd className={KBD}>k</kbd> move · <kbd className={KBD}>↵</kbd> open · <kbd className={KBD}>n</kbd> start an agent · <kbd className={KBD}>Esc</kbd> clear
            <span className="hidden @xl:inline">
              {" "}
              · <kbd className={KBD}>F6</kbd> regions · <kbd className={KBD}>⌘K</kbd> jump · <kbd className={KBD}>⌘J</kbd> Pip
            </span>
          </p>
          <span className="hidden shrink-0 @3xl:inline">Agents use your own Claude settings and account</span>
        </footer>
    </div>
    {side}
    </div>
  );
}

const actions: AgentsActions = {
  select: (id) => useRuns.getState().select(id),
  open: (id) => useRuns.getState().openRun(id),
  attach: (id) => void useRuns.getState().attach(id),
  draftComment: (id) => void useRuns.getState().draftComment(id),
  resume: (id) => void useRuns.getState().answer(id, RESUME_TEXT),
  buildFromPlan: (run) => void askPipInWorkstream(run, pipAsks.build(run)),
  openDraft: (run) => {
    if (run.item) return useRuns.getState().showDraft(run.item);
    const draft = runTicketDraftOf(useWorkspace.getState().proposals, run.id);
    if (!draft) return;
    useRuns.getState().closeSheet();
    showTicketDraft(draft.id);
  },
  openDescription: (run) => {
    if (run.item) useRuns.getState().showDraft(run.item);
  },
  openBreakdown: (run) => {
    const target = breakdownTarget(useWorkspace.getState().proposals, run.id);
    if (target) useRuns.getState().showDraft(target);
  },
  filter: (patch) => useRuns.getState().setFilter(patch),
  clearFilters: () => useRuns.getState().clearFilters(),
  setView: (view) => usePrefs.getState().setAgentsView(view),
  setGroup: (group) => usePrefs.getState().setAgentsGroup(group),
  toggleEarlier: () => useRuns.getState().setEarlierOpen(!useRuns.getState().earlierOpen),
  archive: (id) => void useRuns.getState().archive([id]),
  setIntro: (open) => useRuns.getState().setIntroOpen(open),
  dismissIntro: () => useRuns.getState().setIntroOpen(false),
  retry: () => useRuns.getState().recover(),
  fix: failureAction,
  retryLaunch: (id) => void useRuns.getState().retryLaunch(id),
  copied: (id) => useRuns.getState().noteCopied(id),
  stopAll: () => void useRuns.getState().stopAll(),
  askPip: () => focusPip(),
  openSafety: () => useRuns.getState().openSafety(),
  openNeed,
  openWorkstream: (id) => useWorkView.getState().openWorkstream(id),
};

export function AgentsView() {
  const runs = useRuns((s) => s.runs);
  const archived = useRuns((s) => s.archived);
  const status = useRuns((s) => s.status);
  const error = useRuns((s) => s.error);
  const filters = useRuns((s) => s.filters);
  const selectedId = useRuns((s) => s.selectedId);
  const earlierOpen = useRuns((s) => s.earlierOpen);
  const introOpen = useRuns((s) => s.introOpen);
  const stopping = useRuns((s) => s.stopping);
  const opened = useRuns((s) => s.terminalOpened);
  const needs = useNeedsYou();
  const asking = useWorkView((s) => s.asking);
  const needed = useMemo(() => needsScope(needs), [needs]);
  const inNeeds = useMemo(() => new Map(needs.flatMap((n) => (n.runId ? [[n.runId, n] as const] : []))), [needs]);
  const view = usePrefs((s) => s.agentsView);
  const group = usePrefs((s) => s.agentsGroup);
  const workstreams = useWorkstreams((s) => s.list);
  const closed = useWorkstreams((s) => s.closed);
  const showClosed = useWorkView((s) => s.showClosed);
  const openWorkstream = useWorkView((s) => s.selected);
  const items = useWorkspace((s) => s.items);
  const proposals = useWorkspace((s) => s.proposals);
  const now = useNow();
  const changes = useBuildChanges(runs);
  const verdicts = useReviewVerdicts(runs);

  const orderRef = useRef<string[]>([]);
  const onOrder = useCallback((order: string[]) => {
    orderRef.current = order;
  }, []);

  // A store that lost its backend (a hot reload resets it) never loads by itself.
  useEffect(() => {
    if (status === "idle") useRuns.getState().recover();
  }, [status]);

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      const target = ev.target as HTMLElement;
      // Ctrl+Z undoes the newest offer (or says there is none), unless the person is typing or something sits over the page.
      if ((ev.metaKey || ev.ctrlKey) && !ev.altKey && !ev.shiftKey && ev.key.toLowerCase() === "z") {
        if (ev.defaultPrevented || isTypingTarget(target) || target.closest?.("[role=dialog], #peek-sheet")) return;
        ev.preventDefault();
        return undoLatest();
      }
      if (ev.defaultPrevented || ev.metaKey || ev.ctrlKey || ev.altKey || target.closest?.("input, textarea, select, [contenteditable], [role=dialog], #peek-sheet, #workstream-sheet")) return;
      if (ev.key === "n") {
        if (useRuns.getState().sheet) return;
        ev.preventDefault();
        actions.askPip();
        return;
      }
      // The one key model on a run's card: o opens it, a, d, s and e act as on its row in Needs you.
      const card = target.matches?.("[data-run-id]") ? target : null;
      const runId = card?.getAttribute("data-run-id") ?? null;
      const need = runId ? currentNeeds().find((n) => n.runId === runId) : undefined;
      const asked = useWorkView.getState().asking;
      const listed = agentKey(ev, !!card, !!asked && asked.key === need?.key);
      if (listed) {
        if (listed.type === "confirm") return void (ev.preventDefault(), confirmArmed());
        if (listed.type === "cancel") return void (ev.preventDefault(), disarm());
        if (listed.type === "open") return void (ev.preventDefault(), runId && useRuns.getState().openRun(runId));
        const plan = need ? keyPlan(need, listed.act) : null;
        if (need && plan) {
          ev.preventDefault();
          if (plan.type === "ask") return arm(need, plan);
          if (plan.type === "do") return plan.run();
          return openNeed(need, { edit: plan.edit });
        }
      }
      const { selectedId: current, select } = useRuns.getState();
      const action = keyAction(ev.key, current, orderRef.current);
      if (!action) return;
      ev.preventDefault();
      if (action.type === "clear") {
        select(null);
        if (target.closest?.("[data-run-id]")) target.blur();
        return;
      }
      select(action.id);
      const el = document.getElementById(agentId(action.id));
      el?.focus();
      el?.scrollIntoView({ block: "nearest" });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const onShowClosed = (on: boolean) => {
    useWorkView.getState().setShowClosed(on);
    if (on) void useWorkstreams.getState().loadClosed();
  };
  return (
    <DecisionScope>
      <AgentsScreen
        onOrder={onOrder}
        runs={runs}
        status={status}
        error={error}
        filters={filters}
        selectedId={selectedId}
        earlierOpen={earlierOpen}
        introShown={introOpen}
        view={view}
        group={group}
        workstreams={workstreams}
        openWorkstream={openWorkstream}
        needed={needed}
      side={openWorkstream ? <WorkstreamSheet id={openWorkstream} /> : null}
        tools={<WorkstreamTools showClosed={showClosed} onShowClosed={onShowClosed} />}
        closedSection={showClosed ? <ClosedWorkstreams closed={closed} open={workstreams} /> : null}
        stopping={stopping}
        clear={<ClearFinished runs={runs} />}
        archivedSection={<ArchivedSection runs={archived} now={now} />}
        opened={opened}
        needsYou={needs.length}
        inNeeds={inNeeds}
        asking={asking}
        now={now}
        ticketTitle={(run) => (run.item ? (items[itemKey(run.item)]?.title ?? null) : null)}
        draftReady={(run) => !!runDraftOf(proposals, run.id) || !!runTicketDraftOf(proposals, run.id)}
        breakdownReady={(run) => !!runBreakdownDraftOf(proposals, run.id)}
        descriptionReady={(run) => !!runDescriptionDraftOf(proposals, run.id)}
        reviewThis={(run) => {
          const change = changes[run.id] ?? null;
          return change && reviewThisControl(run, change).enabled ? () => void askPipInWorkstream(run, pipAsks.review(run)) : undefined;
        }}
        reviewOf={(run) => shownVerdict(run, verdicts)}
        on={actions}
      />
    </DecisionScope>
  );
}
