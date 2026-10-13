import { useEffect, useMemo, useRef, useState } from "react";
import { GROUP_LABEL, needGroups, type Need, type NeedGroup, type NeedGroupKind } from "../lib/needs";
import { relativeTime } from "../lib/views";
import { useWorkspace } from "../workspaceStore";
import { draftSummary, draftTitle } from "./DraftCard";
import { groupId, openNeed } from "./needsActions";
import { freezeBatch, type BatchSnapshot } from "./pipHomeLogic";
import { usePipHome } from "./pipHomeStore";
import { BatchConfirm, confirmBatch } from "./StepRail";
import { useToasts } from "./toasts";
import { needsYouText } from "./useNeeds";

const CHIP: Record<NeedGroupKind, string> = {
  decide: "bg-ws-pip text-ws-on-pip",
  unblock: "bg-ws-warn/15 text-ws-warn",
  approve: "bg-ws-accent-soft text-ws-accent",
};

/** What kind of ask a need is: Decide, Unblock or Approve. */
export function GroupChip({ group }: { group: NeedGroupKind }) {
  return (
    <span data-needs-you-chip={group} className={`shrink-0 rounded-full px-1.5 text-[10px] leading-4 font-semibold ${CHIP[group]}`}>
      {GROUP_LABEL[group]}
    </span>
  );
}

const age = (need: Pick<Need, "at">, now: number) => relativeTime(need.at, new Date(now));

/** A group's whole line, for its name and tooltip: the ticket, what is asked, why, how long it has waited, and how many more. */
export function groupText(g: NeedGroup, now: number): string {
  const more = g.count > 1 ? ` · +${g.count - 1} more` : "";
  return `${g.ticketKey ? `${g.ticketKey} · ` : ""}${g.title} · ${GROUP_LABEL[g.top.group]} · ${g.top.why} · ${age(g.top, now)}${more}`;
}

const ROW = "grid w-full rounded px-2 py-1 text-left text-sm leading-snug text-ws-ink2 hover:bg-ws-hover focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ws-pip";

/** The line a row shows while a key waits for Enter. */
function Asking({ need }: { need: Need }) {
  const asking = usePipHome((s) => s.asking);
  if (asking?.key !== need.key) return null;
  return (
    <span data-needs-asking role="status" className="text-xs font-semibold text-ws-pip">
      {asking.text}
    </span>
  );
}

/**
 * "Approve N safe drafts" under a group's needs, with what each would do in one combined preview, then a confirm: the
 * same step the step rail's "Approve these N" asks, over exactly the drafts it showed (`freezeBatch`, `confirmBatch`).
 */
function SafeBatch({ needs, gid }: { needs: readonly Need[]; gid: string }) {
  const proposals = useWorkspace((s) => s.proposals);
  const drafts = needs.flatMap((n) => (n.target.type === "draft" && proposals[n.target.id] ? [proposals[n.target.id]] : []));
  const [frozen, setFrozen] = useState<BatchSnapshot | null>(null);
  const [outcome, setOutcome] = useState<{ text: string; failed: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const ask = useRef<HTMLButtonElement>(null);
  // The palette's "Approve all safe drafts in …" opens the same preview and its confirm; it approves nothing itself.
  const asked = usePipHome((s) => s.batchPreview === gid);
  const count = drafts.length;
  useEffect(() => {
    if (!asked) return;
    usePipHome.setState({ batchPreview: null });
    if (count >= 2) {
      setOutcome(null);
      setFrozen(freezeBatch(drafts));
    }
    // The preview is frozen from the drafts as they are when it opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asked]);
  if (drafts.length < 2 && !outcome) return null;
  const confirm = async (covered: BatchSnapshot) => {
    setFrozen(null);
    setBusy(true);
    try {
      const done = await confirmBatch(covered, drafts, (id) => useWorkspace.getState().approve(id));
      setOutcome(done);
      // The drafts leave Needs you as they are approved, which can take this line with them.
      useToasts.getState().push(done.text, done.failed ? "error" : "info");
    } finally {
      setBusy(false);
    }
  };
  return (
    <li data-needs-you-batch className="grid gap-1.5 px-2 py-1">
      {frozen ? (
        <>
          <ul data-needs-you-batch-preview aria-label="What approving these does" className="m-0 grid list-none gap-0.5 p-0 text-xs text-ws-ink2">
            {drafts
              .filter((p) => frozen.some((f) => f.id === p.id))
              .map((p) => (
                <li key={p.id} className="[overflow-wrap:anywhere]">
                  <b className="font-semibold text-ws-ink">{draftTitle(p)}</b> · <span className="line-clamp-2">{draftSummary(p, null)}</span>
                </li>
              ))}
          </ul>
          <BatchConfirm
            count={frozen.length}
            onConfirm={() => void confirm(frozen)}
            onCancel={() => {
              setFrozen(null);
              requestAnimationFrame(() => ask.current?.focus());
            }}
          />
        </>
      ) : (
        drafts.length >= 2 && (
          <div>
            <button
              ref={ask}
              type="button"
              disabled={busy}
              onClick={() => (setOutcome(null), setFrozen(freezeBatch(drafts)))}
              className="rounded-md border border-ws-sep2 px-2.5 py-px text-sm font-semibold text-ws-ink hover:bg-ws-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ws-pip disabled:opacity-45"
            >
              {busy ? "Approving…" : `Approve ${drafts.length} safe drafts`}
            </button>
          </div>
        )
      )}
      {outcome && (
        <p role="status" data-batch-outcome className={`m-0 text-sm [overflow-wrap:anywhere] ${outcome.failed ? "text-ws-blocked" : "text-ws-ink2"}`}>
          {outcome.text}
        </p>
      )}
    </li>
  );
}

function NeedRow({ need, gid, now, onPick, showTicket }: { need: Need; gid: string; now: number; onPick?(need: Need): void; showTicket: boolean }) {
  const deciding = usePipHome((s) => s.deciding === need.key);
  const text = `${need.head ? `${need.head} · ` : ""}${need.title} · ${age(need, now)}`;
  return (
    <li>
      <button
        type="button"
        data-needs-you-need={need.key}
        data-need-key={need.key}
        data-gid={gid}
        data-kind={need.kind}
        data-group={need.group}
        aria-current={deciding ? "true" : undefined}
        title={text}
        onClick={() => (onPick?.(need), openNeed(need))}
        className={`${ROW} ${deciding ? "bg-ws-sel" : ""}`}
      >
        {/* A need in General, or one about another ticket than its workstream's, says which ticket: the key, then its title. */}
        {showTicket && need.head && (
          <span data-needs-you-head className="truncate text-xs text-ws-ink2">
            {need.head}
          </span>
        )}
        <span className="flex min-w-0 items-center gap-1.5">
          <span data-needs-you-need-title title={need.title} className="line-clamp-2 min-w-0 flex-1 [overflow-wrap:anywhere] text-ws-ink">
            {need.title}
          </span>
          <GroupChip group={need.group} />
          <span className="shrink-0 text-xs text-ws-ink3">{age(need, now)}</span>
        </span>
        <Asking need={need} />
      </button>
    </li>
  );
}

function GroupRow({ group: g, now, onPick }: { group: NeedGroup; now: number; onPick?(need: Need): void }) {
  const gid = groupId(g.workstreamId);
  const open = usePipHome((s) => s.expanded.has(gid));
  const deciding = usePipHome((s) => s.deciding === g.top.key);
  const text = groupText(g, now);
  const list = `needs-you-group-${gid}`;
  const expanded = g.count > 1 && open;
  return (
    <li data-needs-you-row={gid} className="grid">
      <button
        type="button"
        data-needs-you-group={gid}
        data-need-key={g.top.key}
        data-needs-count={g.count}
        data-kind={g.top.kind}
        data-group={g.top.group}
        aria-expanded={g.count > 1 ? expanded : undefined}
        aria-controls={g.count > 1 ? list : undefined}
        aria-current={deciding ? "true" : undefined}
        title={text}
        onClick={() => {
          onPick?.(g.top);
          if (g.count > 1) usePipHome.getState().setExpanded(gid, true);
          openNeed(g.top);
        }}
        className={`${ROW} ${deciding ? "bg-ws-sel" : ""}`}
      >
        <span className="flex min-w-0 items-start gap-1.5">
          {g.ticketKey && <b data-needs-you-key className="shrink-0 font-mono font-semibold text-ws-ink">{g.ticketKey}</b>}
          <span data-needs-you-head className="line-clamp-2 min-w-0 flex-1 [overflow-wrap:anywhere] text-ws-ink">
            {g.title}
          </span>
          <GroupChip group={g.top.group} />
        </span>
        <span data-needs-you-why className="line-clamp-2 text-xs text-ws-ink2 [overflow-wrap:anywhere]">
          {/* General holds needs about any ticket, so its row names the top one's. */}
          {g.workstreamId === null && g.top.ticketKey && <b className="font-mono font-semibold text-ws-ink">{g.top.ticketKey} </b>}
          {g.top.why}
        </span>
        <Asking need={g.top} />
      </button>
      <div className="flex items-center gap-1.5 px-2 pb-0.5 text-xs text-ws-ink3">
        <span data-needs-you-age>{age(g.top, now)}</span>
        {g.count > 1 && (
          <button
            type="button"
            data-needs-you-more
            aria-expanded={expanded}
            aria-controls={list}
            onClick={() => usePipHome.getState().setExpanded(gid, !open)}
            className="rounded px-1 font-semibold text-ws-accent hover:underline focus-visible:outline-2 focus-visible:outline-ws-pip"
          >
            {expanded ? "Show less" : `+${g.count - 1} more`}
          </button>
        )}
      </div>
      {expanded && (
        <ul id={list} data-needs-you-needs aria-label={`Everything that needs you in ${g.title}`} className="m-0 grid list-none gap-0.5 border-l border-ws-sep pl-1.5 ml-2 p-0">
          {[g.top, ...g.rest].map((n) => (
            <NeedRow key={n.key} need={n} gid={gid} now={now} onPick={onPick} showTicket={g.workstreamId === null || n.ticketKey !== g.ticketKey} />
          ))}
          <SafeBatch needs={g.safeBatch} gid={gid} />
        </ul>
      )}
    </li>
  );
}

export interface NeedsYouListProps {
  needs: readonly Need[];
  /** The rail popover's form: no border of its own, a shorter list. */
  compact?: boolean;
  /** Pip home's form: the main left column, taking the height it is given and scrolling inside it. */
  main?: boolean;
  /** Called with the need activated, before it opens; the popover closes itself with it. */
  onPick?(need: Need): void;
  /** The current time in ms, for the ages; a test passes its own. */
  now?: number;
}

/**
 * The Needs you list: the one count, then a row for each workstream (and General) with something waiting on the person,
 * the highest-ranked need first, "+N more" for the rest. Activating a row opens its need's decision; expanding it lists
 * every need in it, with "Approve N safe drafts" over the drafts that may go together.
 */
export function NeedsYouList({ needs, compact = false, main = false, onPick, now = Date.now() }: NeedsYouListProps) {
  const groups = useMemo(() => needGroups(needs), [needs]);
  return (
    <section aria-label="Needs you" data-needs-you className={`grid min-h-0 content-start gap-1 overflow-y-auto ${compact ? "max-h-[min(400px,60vh)] p-2" : main ? "flex-1 px-1.5 pb-2" : "max-h-[38vh] border-t border-ws-sep pt-2"}`}>
      <h2 data-needs-you-title tabIndex={-1} className={`sticky top-0 z-10 m-0 flex items-center gap-1.5 px-1 outline-none font-semibold tracking-wide uppercase ${main ? "bg-ws-bar pt-2 pb-1 text-sm text-ws-ink2" : "bg-ws-win text-xs text-ws-ink3"}`}>
        Needs you
        <span data-needs-you-count aria-label={needsYouText(needs.length)} className={`rounded-full px-1.5 text-[10px] ${needs.length ? "bg-ws-pip text-ws-on-pip" : "bg-ws-hover text-ws-ink3"}`}>
          {needs.length}
        </span>
      </h2>
      {groups.length === 0 ? (
        <p data-needs-you-empty className="m-0 px-1 text-sm text-ws-ink3">
          Nothing needs you.
        </p>
      ) : (
        <ul className="m-0 grid list-none gap-1 p-0">
          {groups.map((g) => (
            <GroupRow key={groupId(g.workstreamId)} group={g} now={now} onPick={onPick} />
          ))}
        </ul>
      )}
    </section>
  );
}
