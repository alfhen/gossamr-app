import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { isArchivable } from "../lib/archiveRuns";
import { itemKey } from "../lib/filter";
import type { Need } from "../lib/needs";
import type { ReviewView, Run, WorkstreamView } from "../types";
import { useWorkspace } from "../workspaceStore";
import { AgentCard, agentId, type AgentItemProps } from "./AgentCard";
import { Icon } from "./AgentIcons";
import { ArchivedSection } from "./ArchivedSection";
import { ClearFinished } from "./ClearFinished";
import { AgentsBanners } from "./AgentsBanners";
import { AgentsEmpty, NoMatch } from "./AgentsEmpty";
import { agentGroups, stepRun, slotWaiters, stopAllText, stoppable, needsScope, type AgentFilters, type NeedsScope, type WorkstreamGroup } from "./agentsLogic";
import { useFooterHeight } from "./CanvasFooter";
import { failureAction } from "./failureActions";
import type { FailureAct } from "./failureHelp";
import { useBuildChanges, useReviewVerdicts } from "./reviewVerdicts";
import { showDraft as showTicketDraft } from "./draftTicket";
import { breakdownTarget, buildFromPlanControl, commentControl, pipAsks, reviewThisControl, runBreakdownDraftOf, runDescriptionDraftOf, runDraftOf, runTicketDraftOf, shownVerdict } from "./runSheetLogic";
import { setNoticeOpener, useRuns } from "./runsStore";
import { askPip, askPipInWorkstream } from "./askPip";
import { focusPip, useWorkstreams } from "./workstreamsStore";
import { stableGroups } from "./stableOrder";
import { useNow } from "./useNow";
import { agentKey } from "./agentKeys";
import { ClosedWorkstreams, DecisionScope, NeedsBadge, WorkstreamHeadExtras, WorkstreamTools, rowTitle } from "./AgentsHome";
import { WorkstreamSheet } from "./WorkstreamSheet";
import { arm, confirmArmed, disarm, keyPlan, openNeed, openRunOrNeed } from "./needsActions";
import { isTypingTarget, keysOf, pressed } from "../lib/keys";
import { ShortcutHint } from "./ShortcutHint";
import { undoLatest } from "./undo";
import { NO_WORKSTREAM_ID, useWorkView } from "./workViewStore";
import { currentNeeds, useNeedsYou } from "./useNeeds";
import { needsIn } from "../lib/needs";

const BUTTON = "inline-flex items-center gap-1.5 rounded-md border border-ws-sep2 px-2.5 py-px text-sm leading-normal whitespace-nowrap hover:bg-ws-hover disabled:cursor-not-allowed disabled:opacity-45";

export { useNow };

// A notification or nudge for a run that needs the person opens its need; runsStore cannot import needsActions without a cycle.
setNoticeOpener(openRunOrNeed, () => needsScope(currentNeeds()));

const NO_WORKSTREAMS: readonly WorkstreamView[] = [];

export type KeyAction = { type: "select"; id: string } | { type: "clear" };

/** What j, k and Esc do on the list; null when the key is not ours or there is nothing to do. */
export function keyAction(key: string, current: string | null, order: readonly string[]): KeyAction | null {
  const [next, prev, back] = [keysOf("list", "next")[0], keysOf("list", "prev")[0], keysOf("list", "back")[0]];
  if (key === next || key === prev) {
    const id = stepRun(order, current, key === next ? 1 : -1);
    return id ? { type: "select", id } : null;
  }
  return key === back && current ? { type: "clear" } : null;
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

export interface AgentsActions {
  select(id: string | null): void;
  open(id: string): void;
  attach(id: string): void;
  draftComment(id: string): void;
  buildFromPlan(run: Run): void;
  /** Shows the comment draft a finished run left on its ticket. */
  openDraft?(run: Run): void;
  openBreakdown?(run: Run): void;
  openDescription?(run: Run): void;
  filter(patch: Partial<AgentFilters>): void;
  clearFilters(): void;
  stop(id: string): void;
  archive?(id: string): void;
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

/** The Work screen's one filter: Needs you, with the same count as the rail badge. */
function NeedsFilter({ needsYou, filters, on }: { needsYou: number; filters: AgentFilters; on: AgentsActions }) {
  return (
    <div role="group" aria-label="Show" data-summary-chips>
      <button
        type="button"
        data-chip="needs"
        aria-pressed={filters.needs}
        onClick={() => on.filter({ needs: !filters.needs })}
        className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-px text-sm leading-normal font-semibold whitespace-nowrap focus-visible:outline-2 focus-visible:outline-ws-pip ${filters.needs ? "border-ws-pip bg-ws-pip text-ws-on-pip" : "border-ws-pip text-ws-ink hover:bg-ws-hover"}`}
      >
        Needs you
        <span data-chip-count data-needs-you-count>
          {needsYou}
        </span>
        {needsYou === 0 && <span className="sr-only">Nothing needs you.</span>}
      </button>
    </div>
  );
}

/** A workstream's runs on the Work screen, under its title and its one status word; its detail opens from the heading. */
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
  /** The open workstreams, for their titles and where they stand. */
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
export function AgentsScreen({ runs, status, error, filters, selectedId, workstreams = NO_WORKSTREAMS, openWorkstream = null, needed, tools, closedSection, side, stopping, clear, archivedSection, opened, needsYou, inNeeds, asking, now, ticketTitle, draftReady, breakdownReady, descriptionReady, reviewThis, reviewOf, on, onOrder }: AgentsScreenProps) {
  const footer = useFooterHeight();
  // While the pointer is over the list or focus is in it, cards keep their places; the normal sort applies once both leave.
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const frozen = hovered || focused;
  const sorted = useMemo(() => agentGroups(runs, workstreams, filters, needed), [runs, workstreams, filters, needed]);
  const shownBefore = useRef<WorkstreamGroup[] | null>(null);
  const { workstreams: wsGroups, order } = useMemo(() => {
    const before = shownBefore.current;
    if (!frozen || !before) return sorted;
    const kept = stableGroups(before, sorted.workstreams, true, (g) => g.id ?? "none");
    return { workstreams: kept, order: kept.flatMap((g) => g.runs.map((r) => r.id)) };
  }, [sorted, frozen]);
  // Recorded once committed, so a render React discards never becomes the order the next frozen render keeps.
  useLayoutEffect(() => {
    shownBefore.current = wsGroups;
  }, [wsGroups]);
  // Published in the commit, not after paint: j and k read this from a native window listener, which a passive effect can trail by one event.
  useLayoutEffect(() => onOrder?.(order), [order, onOrder]);
  // A workstream with no run yet is a group too, so the list is not empty while one exists.
  const shown = wsGroups.reduce((n, g) => n + g.runs.length, 0) + wsGroups.filter((g) => g.runs.length === 0).length;

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
    onStop: () => on.stop(run.id),
    draftReady: !!draftReady?.(run),
    breakdownReady: !!breakdownReady?.(run),
    onOpenDraft: on.openDraft ? () => on.openDraft?.(run) : undefined,
    onOpenBreakdown: on.openBreakdown ? () => on.openBreakdown?.(run) : undefined,
    descriptionReady: !!descriptionReady?.(run),
    onOpenDescription: on.openDescription ? () => on.openDescription?.(run) : undefined,
    onBuildFromPlan: buildFromPlanControl(run).enabled ? () => on.buildFromPlan(run) : undefined,
    onArchive: on.archive && isArchivable(run) ? () => on.archive?.(run.id) : undefined,
    onReviewThis: reviewThis?.(run),
    review: reviewOf?.(run),
    onDraftComment: run.state === "done" && commentControl(run).enabled ? () => on.draftComment(run.id) : undefined,
    onOpenNeed: inNeeds?.has(run.id) ? () => on.openNeed?.(inNeeds.get(run.id)!) : undefined,
    asking: asking && inNeeds?.get(run.id)?.key === asking.key ? asking.text : undefined,
    failure: { opened: opened.has(run.id), on: { act: (act) => on.fix(run.id, act), retry: () => on.retryLaunch(run.id), copied: () => on.copied(run.id) } },
  });

  let position = 0;
  /** A workstream's runs as rows. */
  const items = (title: string, list: readonly Run[], labels: Record<string, string> = {}) => (
    <div role="group" aria-label={title} className="grid gap-2">
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
            Work
          </h1>
          <NeedsFilter needsYou={needsYou ?? 0} filters={filters} on={on} />
          <span className="flex-1" />
          <button type="button" onClick={on.askPip} className={`${BUTTON} border-ws-pip bg-ws-pip font-semibold text-ws-on-pip hover:bg-ws-pip hover:brightness-110`}>
            <Icon name="spark" />
            Ask Pip
          </button>
          <button type="button" onClick={on.openSafety} className={BUTTON}>
            <Icon name="shield" />
            Agent settings
          </button>
          {clear}
          <StopAll count={stoppable(runs).length} waiting={slotWaiters(runs).length} busy={stopping} onStop={on.stopAll} />
        </header>
        {tools && <div className="flex flex-wrap items-center gap-2 border-b border-ws-sep px-6 py-1.5">{tools}</div>}
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
            {waiting ? (
              <p role="status" className="m-0 py-10 text-center text-ws-ink3">
                Loading agents…
              </p>
            ) : runs.length === 0 && shown === 0 ? (
              status !== "error" && <AgentsEmpty />
            ) : shown === 0 ? (
              <NoMatch hidden={runs.length} onClear={on.clearFilters} />
            ) : (
              wsGroups.map((g) => (
                <WorkstreamSection key={g.id ?? "none"} group={g} view={g.id ? workstreams.find((w) => w.workstream.id === g.id) : undefined} current={(g.id ?? NO_WORKSTREAM_ID) === openWorkstream} onOpen={on.openWorkstream}>
                  {g.runs.length ? items(g.title, g.runs, g.labels) : <p data-workstream-empty className="m-0 text-sm text-ws-ink3">{filters.needs ? "Open it to see what needs you." : "No agents on this workstream yet."}</p>}
                </WorkstreamSection>
              ))
            )}
            {!waiting && closedSection}
            {!waiting && archivedSection}
          </div>
        </div>
        <footer ref={footer} className="@container flex h-8 shrink-0 items-center gap-4 border-t border-ws-sep bg-ws-win px-6 text-xs text-ws-ink3">
          <ShortcutHint on="work" />
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
  draftComment: (id) => { const run = useRuns.getState().runs.find((entry) => entry.id === id); if (run) askPip(pipAsks.comment(run)); },
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
  stop: (id) => void useRuns.getState().stop(id),
  archive: (id) => void useRuns.getState().archive([id]),
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
  const stopping = useRuns((s) => s.stopping);
  const opened = useRuns((s) => s.terminalOpened);
  const needs = useNeedsYou();
  const asking = useWorkView((s) => s.asking);
  const needed = useMemo(() => needsScope(needs), [needs]);
  const inNeeds = useMemo(() => new Map(needs.flatMap((n) => (n.runId ? [[n.runId, n] as const] : []))), [needs]);
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
      if (pressed(ev, "work", "undo")) {
        if (ev.defaultPrevented || target.closest?.("[role=dialog], #peek-sheet")) return;
        ev.preventDefault();
        return undoLatest();
      }
      if (ev.defaultPrevented || ev.metaKey || ev.ctrlKey || ev.altKey || isTypingTarget(target) || target.closest?.("[role=dialog], #peek-sheet, #workstream-sheet")) return;
      if (pressed(ev, "work", "ask")) {
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
