import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type UIEvent } from "react";
import { useClaude, type Turn } from "../claudeStore";
import { GENERAL_CONVERSATION, workstreamConversation } from "../lib/conversations";
import { itemKey } from "../lib/filter";
import type { Need } from "../lib/needs";
import {
  EMPTY_FILTER,
  everyWorkstreamParts,
  filterCounts,
  filterTimeline,
  timeline,
  timelineAcross,
  timelineDrafts,
  timelineRuns,
  type ReviewOutcome,
  type TimelineEntry,
  type TimelineFilter,
  type TimelineScope,
} from "../lib/timeline";
import { labelsByRun } from "../lib/workstreamStage";
import type { Proposal, Run, WorkstreamEvent, WorkstreamView } from "../types";
import { useWorkspace } from "../workspaceStore";
import { AgentRow } from "./AgentRow";
import { LiveDraftPreview, openLiveDraft } from "./DraftPreview";
import { GENERAL_INTRO, IntroAction, TurnView, workstreamIntro } from "./PipConversation";
import { openNeed } from "./needsActions";
import { isTypingTarget } from "./pipHomeKeys";
import { usePipHome } from "./pipHomeStore";
import { useReviewVerdicts } from "./reviewVerdicts";
import { useRuns } from "./runsStore";
import { TIMELINE_ENTRY, followsEnd, nearBottom, stepIndex, timelineKeyAction, timelineStop } from "./timelineKeys";
import { PipRunCard } from "./PipRunCard";
import { TimelineFilterBar, TimelineScopeToggle, showAllRuns, showTimeline } from "./TimelineFilterBar";
import { useWorkstreams } from "./workstreamsStore";

const NO_TURNS: Turn[] = [];
const NO_EVENTS: readonly WorkstreamEvent[] = [];
const NO_NEEDS: readonly Need[] = [];

export { timelineDrafts, timelineRuns };

/** Every entry of the conversation's timeline, from the live stores, oldest first; with what each entry is about, by id. */
export function useTimeline(conversation: string, view: WorkstreamView | null, proposals: readonly Proposal[], needs: readonly Need[]) {
  const turns = useClaude((s) => s.byTicket[conversation]?.turns) ?? NO_TURNS;
  const allRuns = useRuns((s) => s.runs);
  const id = view?.workstream.id ?? null;
  const events = useWorkstreams((s) => (id ? s.events[id] : undefined)) ?? NO_EVENTS;
  useEffect(() => {
    if (id) void useWorkstreams.getState().loadEvents(id);
  }, [id]);
  const runs = useMemo(() => timelineRuns(allRuns, view), [allRuns, view]);
  const reviews = useReviewVerdicts(runs);
  const asked = useMemo(() => new Set(turns.map((t) => t.requestId)), [turns]);
  const drafts = useMemo(() => timelineDrafts(proposals, !!view, asked), [proposals, view, asked]);
  const labels = useMemo(() => labelsByRun(allRuns), [allRuns]);
  const verdicts = useMemo(() => Object.fromEntries(Object.entries(reviews).map(([k, v]) => [k, (v?.verdict ?? null) as ReviewOutcome])), [reviews]);
  const entries = useMemo(
    () => timeline({ turns, runs, drafts, events: id ? events : NO_EVENTS, needs, labels, verdicts, ticketKey: view?.workstream.itemKey ?? null }),
    [turns, runs, drafts, events, id, needs, labels, verdicts, view],
  );
  const byId = useMemo(
    () => ({ turns: new Map(turns.map((t) => [t.requestId, t])), runs: new Map(runs.map((r) => [r.id, r])), drafts: new Map(drafts.map((p) => [p.id, p])), needs: new Map(needs.map((n) => [n.key, n])) }),
    [turns, runs, drafts, needs],
  );
  const behind = useMemo(() => queuedBehind([turns]), [turns]);
  return { entries, byId, labels, turns, behind };
}

/** The questions that wait behind another one queued in the same conversation, by request id. */
function queuedBehind(conversations: readonly (readonly Turn[])[]): Set<string> {
  const out = new Set<string>();
  for (const turns of conversations) {
    const first = turns.find((t) => t.status === "queued")?.requestId;
    for (const t of turns) if (t.status === "queued" && t.requestId !== first) out.add(t.requestId);
  }
  return out;
}

const NO_RUNS: readonly Run[] = [];
const NO_ENTRIES: TimelineEntry[] = [];

/**
 * Every workstream's timeline (`on`): each open workstream's and General's, merged by time (`timelineAcross`), each entry
 * carrying its ticket or "General". It loads every open workstream's conversation and audit while it is on. Empty while off.
 */
export function useEveryTimeline(needs: readonly Need[], on: boolean) {
  const byTicket = useClaude((s) => s.byTicket);
  const views = useWorkstreams((s) => s.list);
  const events = useWorkstreams((s) => s.events);
  const proposalMap = useWorkspace((s) => s.proposals);
  const allRuns = useRuns((s) => s.runs);
  const open = useMemo(() => views.filter((v) => v.workstream.closedAt === null), [views]);
  const ids = open.map((v) => v.workstream.id).join(" ");
  useEffect(() => {
    if (!on) return;
    void useClaude.getState().load(GENERAL_CONVERSATION);
    for (const id of ids.split(" ").filter(Boolean)) {
      void useClaude.getState().load(workstreamConversation(id));
      void useWorkstreams.getState().loadEvents(id);
    }
  }, [on, ids]);
  const reviews = useReviewVerdicts(on ? allRuns : NO_RUNS);
  const labels = useMemo(() => labelsByRun(allRuns), [allRuns]);
  const verdicts = useMemo(() => Object.fromEntries(Object.entries(reviews).map(([k, v]) => [k, (v?.verdict ?? null) as ReviewOutcome])), [reviews]);
  const conversations = useMemo(() => {
    if (!on) return [] as [string, Turn[]][];
    return [GENERAL_CONVERSATION, ...open.map((v) => workstreamConversation(v.workstream.id))].map((c) => [c, byTicket[c]?.turns ?? NO_TURNS] as [string, Turn[]]);
  }, [on, open, byTicket]);
  const proposals = useMemo(() => Object.values(proposalMap).filter((p): p is Proposal => !!p), [proposalMap]);
  const entries = useMemo(
    () => (on ? timelineAcross(everyWorkstreamParts({ views: open, turns: Object.fromEntries(conversations), runs: allRuns, proposals, events, needs, labels, verdicts })) : NO_ENTRIES),
    [on, open, conversations, allRuns, proposals, events, needs, labels, verdicts],
  );
  const turns = useMemo(() => conversations.flatMap(([, t]) => t), [conversations]);
  const byId = useMemo(
    () => ({ turns: new Map(turns.map((t) => [t.requestId, t])), runs: new Map(allRuns.map((r) => [r.id, r])), drafts: new Map(proposals.map((p) => [p.id, p])), needs: new Map(needs.map((n) => [n.key, n])) }),
    [turns, allRuns, proposals, needs],
  );
  const behind = useMemo(() => queuedBehind(conversations.map(([, t]) => t)), [conversations]);
  return { entries, byId, labels, turns, behind };
}

type Lookup = ReturnType<typeof useTimeline>["byId"];

/** Opens what entry `e` is about: its need in Needs you's decision pane, a run's sheet over Pip home, a draft's card. */
export function openEntry(e: Pick<TimelineEntry, "target">, byId: Lookup, root: ParentNode | null) {
  const t = e.target;
  if (!t) return;
  if (t.type === "need") {
    const need = byId.needs.get(t.key);
    if (need) openNeed(need);
    return;
  }
  if (t.type === "run") return useRuns.getState().openRun(t.id, { stay: true });
  const card = root?.querySelector<HTMLElement>(`article[data-draft="${CSS.escape(t.id)}"]`);
  if (card) {
    card.scrollIntoView?.({ block: "nearest" });
    return card.focus();
  }
  const p = byId.drafts.get(t.id);
  if (p) openLiveDraft(p, { inline: true });
}

const clock = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
};

function When({ at }: { at: string }) {
  const text = clock(at);
  if (!text) return null;
  return (
    <time dateTime={at} title={new Date(at).toLocaleString()} className="shrink-0 text-xs text-ws-ink3 tabular-nums">
      {text}
    </time>
  );
}

const LINK = "rounded text-left text-ws-ink2 underline-offset-2 hover:text-ws-pip hover:underline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ws-pip";

/** The one line an audit entry, a run's heading or a decided draft says: a dot, the sentence, and what it opens. */
function Line({ entry, onOpen, children }: { entry: TimelineEntry; onOpen?: () => void; children?: ReactNode }) {
  const waiting = !!entry.needKey;
  return (
    <p data-timeline-line className="m-0 flex min-w-0 flex-wrap items-baseline gap-x-1.5 text-sm text-ws-ink2">
      <span aria-hidden className={`size-1.5 shrink-0 self-center rounded-full ${waiting ? "bg-ws-pip" : entry.decision ? "bg-ws-accent" : "bg-ws-sep2"}`} />
      <When at={entry.at} />
      {onOpen && entry.target ? (
        <button type="button" tabIndex={-1} data-timeline-open={entry.target.type} onClick={onOpen} className={LINK}>
          {entry.text}
        </button>
      ) : (
        <span className="min-w-0">{entry.text}</span>
      )}
      {waiting && (
        <button type="button" tabIndex={-1} data-timeline-need={entry.needKey} onClick={onOpen} className="rounded-full border border-ws-pip/50 bg-ws-pip-soft px-2 text-xs leading-[1.6] font-semibold text-ws-pip hover:bg-ws-pip hover:text-ws-on-pip">
          In Needs you
        </button>
      )}
      {children}
    </p>
  );
}

const NOOP = () => {};
const NO_FAILURE = { opened: false, on: { act: NOOP, retry: NOOP, copied: NOOP } };

/**
 * A run's entry: what its life has come to, over the same row the Agents screen lists it with; in the Pip pane (`pane`),
 * over the pane's own narrow card, which keeps the Agents screen's row (and its id) the only one of its kind on screen.
 */
function RunEntry({ entry, run, label, now, need, open, pane }: { entry: TimelineEntry; run: Run; label?: string; now: number; need?: Need; open(): void; pane: boolean }) {
  const items = useWorkspace((s) => s.items);
  const asking = usePipHome((s) => (need && s.asking?.key === need.key ? s.asking.text : undefined));
  const ticketTitle = run.item ? (items[itemKey(run.item)]?.title ?? null) : null;
  return (
    <div className="grid gap-1">
      <Line entry={entry} onOpen={open} />
      {pane ? (
        <PipRunCard run={run} now={now} ticketTitle={ticketTitle} label={label} onOpen={() => useRuns.getState().openRun(run.id, { stay: true })} focusable />
      ) : (
        <div className="@container overflow-hidden rounded-[10px] border border-ws-sep">
          <AgentRow
            run={run}
            now={now}
            selected={false}
            position={1}
            total={1}
            ticketTitle={ticketTitle}
            label={label}
            onOpen={open}
            onAttach={NOOP}
            onOpenNeed={need ? () => openNeed(need) : undefined}
            asking={asking}
            failure={NO_FAILURE}
          />
        </div>
      )}
    </div>
  );
}

/** The small label an entry carries in Every workstream: its ticket, or General. */
function ScopeLabel({ entry }: { entry: TimelineEntry }) {
  if (entry.scopeLabel === undefined) return null;
  return (
    <span data-timeline-workstream={entry.workstreamId ?? "general"} className="justify-self-start rounded bg-ws-hover px-1.5 font-mono text-xs leading-[1.6] font-semibold text-ws-ink2">
      {entry.scopeLabel}
    </span>
  );
}

/**
 * A workstream's timeline: the conversation's turns, each run's one row, the drafts with their cards, and the audit's
 * lines, interleaved oldest first, under the filter (All, Runs, Drafts, Decisions). j and k walk its entries, Enter or o
 * opens what one is about; an entry about something waiting on the person opens its need.
 *
 * On Pip home (the default) the filter and the scope are Pip home's: in Every workstream it is every open workstream's
 * and General's timeline merged, each entry labelled with its ticket, and Runs there is the Agents screen. In the Pip
 * pane (`pane`) it is the pane's workstream alone, with a filter of its own that leaves Pip home's as it was.
 */
export function TimelineView({
  conversation,
  workstream,
  proposals,
  needs = NO_NEEDS,
  primary = null,
  pane = false,
}: {
  conversation: string;
  workstream: WorkstreamView | null;
  proposals: readonly Proposal[];
  needs?: readonly Need[];
  primary?: string | null;
  pane?: boolean;
}) {
  const homeFilter = usePipHome((s) => s.timelineFilter);
  const homeScope = usePipHome((s) => s.timelineScope);
  const [paneFilter, setPaneFilter] = useState<TimelineFilter>("all");
  const filter = pane ? paneFilter : homeFilter;
  const scope: TimelineScope = pane ? "workstream" : homeScope;
  const every = scope === "every";
  const own = useTimeline(conversation, workstream, proposals, needs);
  const across = useEveryTimeline(needs, every);
  const { entries, byId, labels, turns, behind } = every ? across : own;
  const shown = useMemo(() => filterTimeline(entries, filter), [entries, filter]);
  const counts = useMemo(() => filterCounts(entries), [entries]);
  const ref = useRef<HTMLDivElement>(null);
  /** The drafts this timeline has shown waiting: one retired since keeps its card, collapsed with why, rather than vanishing. */
  const seenWaiting = useRef(new Set<string>());
  for (const p of byId.drafts.values()) if (p.state.type === "pending") seenWaiting.current.add(p.id);
  const now = Date.now();

  /** Whether the person is at the end: only then does new text follow it down, so reading older entries isn't undone. */
  const stickToBottom = useRef(true);
  const turnCount = useRef(0);
  useEffect(() => {
    const el = ref.current;
    const before = turnCount.current;
    turnCount.current = turns.length;
    if (!el || !followsEnd(stickToBottom.current, before, turns)) return;
    stickToBottom.current = true;
    el.scrollTo({ top: el.scrollHeight });
  }, [turns, shown.length]);
  const onScroll = (ev: UIEvent<HTMLDivElement>) => {
    stickToBottom.current = nearBottom(ev.currentTarget);
  };

  const onKeyDown = (ev: KeyboardEvent<HTMLDivElement>) => {
    if (ev.defaultPrevented || isTypingTarget(ev.target)) return;
    const target = ev.target as HTMLElement;
    const entry = target.closest<HTMLElement>(TIMELINE_ENTRY);
    if (!entry) return;
    const kind = entry.getAttribute("data-kind");
    // The pane's run card has no Enter of its own: the timeline opens it.
    const action = timelineKeyAction(ev, timelineStop(entry) === target, kind, !pane);
    if (!action) return;
    ev.preventDefault();
    if (action.type === "open") {
      const e = shown.find((x) => x.key === entry.getAttribute("data-timeline-entry"));
      if (e) openEntry(e, byId, ref.current);
      return;
    }
    const list = Array.from(ev.currentTarget.querySelectorAll<HTMLElement>(TIMELINE_ENTRY));
    const next = list[stepIndex(list.indexOf(entry), list.length, action.by)];
    if (!next || next === entry) return;
    const stop = timelineStop(next);
    stop.scrollIntoView?.({ block: "nearest" });
    stop.focus();
  };

  const body = (e: TimelineEntry): ReactNode => {
    const open = () => openEntry(e, byId, ref.current);
    switch (e.kind) {
      case "said":
      case "pip": {
        const t = byId.turns.get(e.turnId!);
        return t ? <TurnView turn={t} proposals={[]} afterQueued={behind.has(t.requestId)} /> : null;
      }
      case "run": {
        const run = byId.runs.get(e.runId!);
        return run ? <RunEntry entry={e} run={run} label={labels.get(run.id)} now={now} need={e.needKey ? byId.needs.get(e.needKey) : undefined} open={open} pane={pane} /> : null;
      }
      case "draft": {
        const p = byId.drafts.get(e.draftId!);
        if (!p) return null;
        // A draft waiting, one Pip made answering here, or one retired after it waited here: its card. Any other decided one: its line.
        const card = p.state.type === "pending" || p.state.type === "applying" || (e.turnId !== undefined && byId.turns.has(e.turnId)) || (p.state.type === "retired" && seenWaiting.current.has(p.id));
        return card ? <LiveDraftPreview proposal={p} /> : <Line entry={e} onOpen={() => openLiveDraft(p, { inline: true })} />;
      }
      case "audit":
        return <Line entry={e} onOpen={e.target ? open : undefined} />;
    }
  };

  const toAgents = (
    <button type="button" data-all-runs onClick={showAllRuns} className="text-sm font-semibold text-ws-accent hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ws-pip">
      Runs in every workstream (Agents)
    </button>
  );
  const empty = turns.length === 0;
  return (
    <div data-timeline-scope-shown={scope} className="flex min-h-0 flex-1 flex-col">
      <div className="border-b border-ws-sep px-3 py-1.5">
        {pane ? (
          <TimelineFilterBar label="Filter" value={filter} counts={counts} onChange={setPaneFilter} after={filter === "runs" && toAgents} />
        ) : (
          <TimelineFilterBar
            value={filter}
            counts={counts}
            onChange={(f) => showTimeline(f, scope)}
            after={<TimelineScopeToggle value={scope} filter={filter} onChange={(s) => showTimeline(filter, s)} />}
          />
        )}
      </div>
      <div ref={ref} data-pip-conversation-body data-timeline onKeyDown={onKeyDown} onScroll={onScroll} className="grid min-h-0 flex-1 content-start gap-4 overflow-auto px-3 pt-3 pb-4">
        {empty &&
          !every &&
          filter === "all" &&
          (workstream ? (
            <div className="grid gap-2.5">
              <p data-empty-workstream className="m-0 text-ws-ink2">
                {workstreamIntro(workstream.workstream)}
              </p>
              {primary && <IntroAction conversation={conversation} text={primary} />}
            </div>
          ) : (
            <p className="m-0 text-ws-ink2">{GENERAL_INTRO}</p>
          ))}
        {shown.length === 0 && (filter !== "all" || every) && (
          <p data-timeline-empty className="m-0 text-sm text-ws-ink3">
            {EMPTY_FILTER[filter]}
          </p>
        )}
        {shown.length > 0 && (
          <ol aria-label="Timeline" className="m-0 grid list-none gap-4 p-0">
            {shown.map((e) => (
              <li
                key={e.key}
                data-timeline-entry={e.key}
                data-kind={e.kind}
                data-phase={e.phase}
                data-waiting={e.needKey ?? undefined}
                tabIndex={-1}
                aria-label={e.kind === "said" || e.kind === "pip" ? undefined : e.scopeLabel ? `${e.scopeLabel}: ${e.text}` : e.text}
                className="grid min-w-0 gap-1 rounded-md outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ws-pip"
              >
                <ScopeLabel entry={e} />
                {body(e)}
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}
