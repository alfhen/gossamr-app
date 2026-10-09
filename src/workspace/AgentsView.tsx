import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { itemKey } from "../lib/filter";
import { labelsByRun, stageText } from "../lib/workstreamStage";
import type { CodeChange, ReviewView, Run, RunsEnvironment, WorkstreamView } from "../types";
import { useWorkspace } from "../workspaceStore";
import { AgentCard, agentId, type AgentItemProps } from "./AgentCard";
import { Icon } from "./AgentIcons";
import { AgentRow, AgentRowHeader } from "./AgentRow";
import { AgentsBanners } from "./AgentsBanners";
import { AgentsEmpty, AgentsIntro, NoMatch } from "./AgentsEmpty";
import {
  AGENTS_GROUPS,
  ALL,
  LANES,
  LANE_IDS,
  agentGroups,
  filterOptions,
  isFiltered,
  laneIsFolded,
  stepRun,
  stoppable,
  summaryLine,
  type AgentFilters,
  type AgentsGroup,
  type LaneGroup,
  type LaneId,
  type WorkstreamGroup,
} from "./agentsLogic";
import { useFooterHeight } from "./CanvasFooter";
import { failureAction } from "./failureActions";
import type { FailureAct } from "./failureHelp";
import { AGENTS_VIEWS, usePrefs, type AgentsViewMode } from "./prefs";
import { useRunSetup } from "./runSetupStore";
import { showDraft as showTicketDraft } from "./draftTicket";
import { breakdownTarget, buildFromPlanControl, buildFromPlanOptions, commentControl, reviewThisControl, reviewThisOptions, runBreakdownDraftOf, runDescriptionDraftOf, runDraftOf, runTicketDraftOf } from "./runSheetLogic";
import { useRuns } from "./runsStore";
import { useWorkstreams } from "./workstreamsStore";

const KBD = "font-sans text-[11px] rounded border border-ws-sep2 bg-ws-bar px-1";
const BUTTON = "inline-flex items-center gap-1.5 rounded-md border border-ws-sep2 px-2.5 py-px text-sm leading-normal whitespace-nowrap hover:bg-ws-hover disabled:cursor-not-allowed disabled:opacity-45";
const VIEW_LABEL: Record<AgentsViewMode, string> = { cards: "Cards", list: "List" };
const GROUP_LABEL: Record<AgentsGroup, string> = { state: "State", workstream: "Workstream" };

/** Re-renders now and then so ages and the quiet chip move without a refresh. */
function useNow(everyMs = 30_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(id);
  }, [everyMs]);
  return now;
}

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

export function StopAll({ count, busy, onStop }: { count: number; busy: boolean; onStop(): void }) {
  const [asking, setAsking] = useState(false);
  useEffect(() => {
    if (count === 0) setAsking(false);
  }, [count]);
  if (!asking) {
    return (
      <button type="button" disabled={count === 0 || busy} title="Stop every agent that is working or waiting" onClick={() => setAsking(true)} className={`${BUTTON} border-ws-blocked text-ws-blocked hover:bg-ws-blocked hover:text-white`}>
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
        Stop {count} {count === 1 ? "agent" : "agents"}? Their work is kept. Agents from Terminal are not touched.
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
  /** Shows the comment draft a finished run left on its ticket. */
  openDraft?(run: Run): void;
  openBreakdown?(run: Run): void;
  openDescription?(run: Run): void;
  filter(patch: Partial<AgentFilters>): void;
  clearFilters(): void;
  setView(view: AgentsViewMode): void;
  setGroup(group: AgentsGroup): void;
  toggleEarlier(): void;
  setIntro(open: boolean): void;
  dismissIntro(): void;
  checkEnvironment(): void;
  retry(): void;
  /** The step a failed launch needs: Terminal, or the install page. */
  fix(id: string, act: FailureAct): void;
  retryLaunch(id: string): void;
  copied(id: string): void;
  stopAll(): void;
  startAgent(): void;
  openSafety(): void;
}

function Toolbar({ runs, filters, view, group, introShown, on }: { runs: readonly Run[]; filters: AgentFilters; view: AgentsViewMode; group: AgentsGroup; introShown: boolean; on: AgentsActions }) {
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
      <button type="button" aria-pressed={introShown} onClick={() => on.setIntro(!introShown)} className="inline-flex items-center gap-1.5 rounded-md px-2 py-px text-sm text-ws-ink2 hover:bg-ws-hover">
        <Icon name="info" />
        How agents work
      </button>
    </div>
  );
}

function Lane({ group, folded, onToggle, children }: { group: LaneGroup; folded: boolean; onToggle?: () => void; children: ReactNode }) {
  const needs = group.lane === "needs";
  return (
    <section aria-label={group.title} data-lane={group.lane} className="grid gap-2.5">
      <div className="flex items-center gap-2">
        <h3 className={`m-0 text-xs font-semibold tracking-[0.05em] uppercase ${needs ? "text-ws-pip" : "text-ws-ink2"}`}>{group.title}</h3>
        <span className="text-xs text-ws-ink3">{group.runs.length}</span>
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

/** A workstream's runs in the Agents view, under its title and the stage they give it. */
function WorkstreamSection({ group, children }: { group: WorkstreamGroup; children: ReactNode }) {
  return (
    <section aria-label={group.title} data-workstream-group={group.id ?? "none"} className="grid gap-2.5">
      <div className="flex min-w-0 items-center gap-2">
        {group.id && (
          <span aria-hidden className="text-ws-pip">
            ◆
          </span>
        )}
        <h3 className={`m-0 min-w-0 truncate text-sm font-semibold ${group.id ? "text-ws-ink" : "text-ws-ink2"}`}>{group.title}</h3>
        {group.stage && (
          <span data-stage={group.stage} data-waiting-for-pr={group.waitingForPr || undefined} className="shrink-0 rounded-full bg-ws-pip-soft px-2 text-xs font-semibold text-ws-pip">
            {stageText(group.stage, group.waitingForPr)}
          </span>
        )}
        <span className="text-xs text-ws-ink3">{group.runs.length}</span>
      </div>
      {children}
    </section>
  );
}

export interface AgentsScreenProps {
  runs: readonly Run[];
  status: "idle" | "loading" | "ready" | "error";
  error: string | null;
  environment: RunsEnvironment | null;
  filters: AgentFilters;
  selectedId: string | null;
  earlierOpen: boolean;
  introShown: boolean;
  view: AgentsViewMode;
  /** How runs are grouped; by state (the lanes) when absent. */
  group?: AgentsGroup;
  /** The open workstreams, for their titles when grouped by workstream. */
  workstreams?: readonly WorkstreamView[];
  stopping: boolean;
  /** Failed runs the person has taken the Terminal step for. */
  opened: ReadonlySet<string>;
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
}

/** The whole screen as a function of its state; `AgentsView` connects it to the stores. */
export function AgentsScreen({ runs, status, error, environment, filters, selectedId, earlierOpen, introShown, view, group = "state", workstreams = NO_WORKSTREAMS, stopping, opened, now, ticketTitle, draftReady, breakdownReady, descriptionReady, reviewThis, reviewOf, on }: AgentsScreenProps) {
  const footer = useFooterHeight();
  const { lanes, workstreams: wsGroups, order } = useMemo(() => agentGroups(group, runs, workstreams, filters, earlierOpen, now), [group, runs, workstreams, filters, earlierOpen, now]);
  const filtered = isFiltered(filters);
  const shown = (lanes ?? wsGroups ?? []).reduce((n, g) => n + g.runs.length, 0);
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
    onReviewThis: reviewThis?.(run),
    review: reviewOf?.(run),
    onDraftComment: run.state === "done" && commentControl(run).enabled ? () => on.draftComment(run.id) : undefined,
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
  const waiting = status === "idle" || (status === "loading" && runs.length === 0);

  return (
    <div className="@container flex h-full min-h-0 flex-col">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-ws-sep bg-ws-bar px-6 py-2.5">
        <h2 className="m-0 text-base font-semibold">Agents</h2>
        <span aria-live="polite" className="text-sm text-ws-ink3">
          {summaryLine(runs, now)}
        </span>
        <span className="flex-1" />
        <button type="button" onClick={on.startAgent} className={`${BUTTON} border-ws-pip bg-ws-pip font-semibold text-ws-on-pip hover:bg-ws-pip hover:brightness-110`}>
          <Icon name="play" />
          Start an agent
        </button>
        <button type="button" onClick={on.openSafety} className={BUTTON}>
          <Icon name="shield" />
          Safety and settings
        </button>
        <StopAll count={stoppable(runs).length} busy={stopping} onStop={on.stopAll} />
      </header>
      <Toolbar runs={runs} filters={filters} view={view} group={group} introShown={introShown} on={on} />
      <div className="min-h-0 flex-1 overflow-y-auto px-6 pt-5 pb-20">
        <div className="grid gap-5.5">
          <AgentsBanners environment={environment} loadError={status === "error" ? error : null} onCheckAgain={on.checkEnvironment} onRetry={on.retry} />
          {introShown && <AgentsIntro onDismiss={on.dismissIntro} />}
          {waiting ? (
            <p role="status" className="m-0 py-10 text-center text-ws-ink3">
              Loading agents…
            </p>
          ) : runs.length === 0 ? (
            !introShown && status !== "error" && <AgentsEmpty />
          ) : shown === 0 ? (
            <NoMatch hidden={runs.length} onClear={on.clearFilters} />
          ) : wsGroups ? (
            wsGroups.map((g, gi) => (
              <WorkstreamSection key={g.id ?? "none"} group={g}>
                {items(g.title, g.runs, gi === 0, g.labels)}
              </WorkstreamSection>
            ))
          ) : (
            (lanes ?? []).map((g, gi) => (
              <Lane key={g.lane} group={g} folded={laneIsFolded(g.lane, earlierOpen, filters)} onToggle={g.lane === "earlier" && !filtered ? on.toggleEarlier : undefined}>
                {items(g.title, g.runs, gi === 0, labels)}
              </Lane>
            ))
          )}
        </div>
      </div>
      <footer ref={footer} className="@container flex h-8 shrink-0 items-center gap-4 border-t border-ws-sep bg-ws-win px-6 text-xs text-ws-ink3">
        <p className="m-0 min-w-0 flex-1 truncate">
          <kbd className={KBD}>j</kbd> <kbd className={KBD}>k</kbd> move · <kbd className={KBD}>↵</kbd> open · <kbd className={KBD}>n</kbd> start an agent · <kbd className={KBD}>Esc</kbd> clear
          <span className="hidden @xl:inline">
            {" "}
            · <kbd className={KBD}>⌘K</kbd> jump · <kbd className={KBD}>⌘J</kbd> Pip
          </span>
        </p>
        <span className="hidden shrink-0 @3xl:inline">Agents use your own Claude settings and account</span>
      </footer>
    </div>
  );
}

const actions: AgentsActions = {
  select: (id) => useRuns.getState().select(id),
  open: (id) => useRuns.getState().openRun(id),
  attach: (id) => void useRuns.getState().attach(id),
  draftComment: (id) => void useRuns.getState().draftComment(id),
  buildFromPlan: (run) => void useRunSetup.getState().begin(buildFromPlanOptions(run)),
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
  setIntro: (open) => useRuns.getState().setIntroOpen(open),
  dismissIntro: () => {
    usePrefs.getState().setAgentsIntroSeen(true);
    useRuns.getState().setIntroOpen(false);
  },
  checkEnvironment: () => void useRuns.getState().checkEnvironment(),
  retry: () => useRuns.getState().recover(),
  fix: failureAction,
  retryLaunch: (id) => void useRuns.getState().retryLaunch(id),
  copied: (id) => useRuns.getState().noteCopied(id),
  stopAll: () => void useRuns.getState().stopAll(),
  startAgent: () => useRuns.getState().setPicking(true),
  openSafety: () => useRuns.getState().openSafety(),
};

const CHANGE_RECHECK_MS = 30_000;

/** The pull request each finished build opened, as the last sync saw it, asked again while a build has none. */
function useBuildChanges(runs: readonly Run[]) {
  const backend = useRuns((s) => s.backend);
  const [changes, setChanges] = useState<Record<string, CodeChange | null>>({});
  const asked = useRef(new Map<string, number>());
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), CHANGE_RECHECK_MS);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!backend) return;
    const at = Date.now();
    for (const run of runs) {
      if (run.spec.kind !== "build" || run.state !== "done" || !run.item || run.resultComplete === false || changes[run.id]?.number != null) continue;
      if (at - (asked.current.get(run.id) ?? 0) < CHANGE_RECHECK_MS) continue;
      asked.current.set(run.id, at);
      backend.runsOutcome(run.id).then(
        (outcome) => setChanges((c) => ({ ...c, [run.id]: outcome.change })),
        () => {},
      );
    }
  }, [backend, runs, changes, tick]);
  return changes;
}

/** The verdict of each finished review, read from its outcome once it is done and again whenever it changes. */
function useReviewVerdicts(runs: readonly Run[]) {
  const backend = useRuns((s) => s.backend);
  const [verdicts, setVerdicts] = useState<Record<string, ReviewView | null>>({});
  const asked = useRef(new Map<string, string>());
  useEffect(() => {
    if (!backend) return;
    for (const run of runs) {
      if (run.spec.kind !== "review" || run.state !== "done") continue;
      const version = `${run.lastProgressAt}|${run.endedAt ?? ""}`;
      if (asked.current.get(run.id) === version) continue;
      asked.current.set(run.id, version);
      backend.runsOutcome(run.id).then(
        (outcome) => setVerdicts((v) => ({ ...v, [run.id]: outcome.review ?? null })),
        () => asked.current.delete(run.id),
      );
    }
  }, [backend, runs]);
  return verdicts;
}

export function AgentsView() {
  const runs = useRuns((s) => s.runs);
  const status = useRuns((s) => s.status);
  const error = useRuns((s) => s.error);
  const environment = useRuns((s) => s.environment);
  const filters = useRuns((s) => s.filters);
  const selectedId = useRuns((s) => s.selectedId);
  const earlierOpen = useRuns((s) => s.earlierOpen);
  const introOpen = useRuns((s) => s.introOpen);
  const stopping = useRuns((s) => s.stopping);
  const opened = useRuns((s) => s.terminalOpened);
  const view = usePrefs((s) => s.agentsView);
  const group = usePrefs((s) => s.agentsGroup);
  const workstreams = useWorkstreams((s) => s.list);
  const introSeen = usePrefs((s) => s.agentsIntroSeen);
  const items = useWorkspace((s) => s.items);
  const proposals = useWorkspace((s) => s.proposals);
  const now = useNow();
  const changes = useBuildChanges(runs);
  const verdicts = useReviewVerdicts(runs);

  const order = useMemo(() => agentGroups(group, runs, workstreams, filters, earlierOpen, now).order, [group, runs, workstreams, filters, earlierOpen, now]);
  const orderRef = useRef(order);
  orderRef.current = order;

  useEffect(() => useRuns.getState().markSeen(), [runs]);

  // A store that lost its backend (a hot reload resets it) never loads by itself.
  useEffect(() => {
    if (status === "idle") useRuns.getState().recover();
  }, [status]);

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      const target = ev.target as HTMLElement;
      if (ev.defaultPrevented || ev.metaKey || ev.ctrlKey || ev.altKey || target.closest?.("input, textarea, select, [contenteditable], [role=dialog], #peek-sheet")) return;
      if (ev.key === "n") {
        if (useRuns.getState().sheet || useRunSetup.getState().open) return;
        ev.preventDefault();
        useRuns.getState().setPicking(true);
        return;
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

  return (
    <AgentsScreen
      runs={runs}
      status={status}
      error={error}
      environment={environment}
      filters={filters}
      selectedId={selectedId}
      earlierOpen={earlierOpen}
      introShown={introOpen ?? (!introSeen && runs.length === 0)}
      view={view}
      group={group}
      workstreams={workstreams}
      stopping={stopping}
      opened={opened}
      now={now}
      ticketTitle={(run) => (run.item ? (items[itemKey(run.item)]?.title ?? null) : null)}
      draftReady={(run) => !!runDraftOf(proposals, run.id) || !!runTicketDraftOf(proposals, run.id)}
      breakdownReady={(run) => !!runBreakdownDraftOf(proposals, run.id)}
      descriptionReady={(run) => !!runDescriptionDraftOf(proposals, run.id)}
      reviewThis={(run) => {
        const change = changes[run.id] ?? null;
        return change && reviewThisControl(run, change).enabled ? () => void useRunSetup.getState().begin(reviewThisOptions(run, change)) : undefined;
      }}
      reviewOf={(run) => verdicts[run.id]}
      on={actions}
    />
  );
}
