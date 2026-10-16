import { useMemo } from "react";
import { chipLabel, editedTitle, GROUP_LABEL, needGroups, type Need, type NeedGroup, type NeedGroupKind } from "../lib/needs";
import { relativeTime } from "../lib/views";
import { isAnswersDraft } from "../lib/proposals";
import { useWorkspace } from "../workspaceStore";
import { useEditedDraft } from "./DraftCard";
import { groupId, openNeed } from "./needsActions";
import { BATCH_ASIDE, BATCH_TITLE, batchLabel } from "./pipHomeLogic";
import { usePipHome } from "./pipHomeStore";

const CHIP: Record<NeedGroupKind, string> = {
  decide: "bg-ws-pip text-ws-on-pip",
  unblock: "bg-ws-warn/15 text-ws-warn",
  approve: "bg-ws-accent-soft text-ws-accent",
};

const CHIP_TITLE: Record<NeedGroupKind, string> = {
  decide: "Decide: a choice only you can make",
  unblock: "Unblock: something is stuck until you answer or allow it",
  approve: "Approve: a draft that waits for your go-ahead before anything is posted",
};

/** What kind of ask a need is: Decide, Unblock or Approve. */
export function GroupChip({ group, label }: { group: NeedGroupKind; /** The chip's word when it isn't the group's (a review draft's "Post"). */ label?: string }) {
  return (
    <span data-needs-you-chip={group} title={CHIP_TITLE[group]} className={`shrink-0 rounded-full px-1.5 text-[10px] leading-4 font-semibold ${CHIP[group]}`}>
      {label ?? GROUP_LABEL[group]}
    </span>
  );
}

const age = (need: Pick<Need, "at">, now: number) => relativeTime(need.at, new Date(now));

/** A group's whole line, for its name and tooltip: the ticket, what is asked, why, how long it has waited, and how many more. */
export function groupText(g: NeedGroup, now: number): string {
  const more = g.count > 1 ? ` · +${g.count - 1} more` : "";
  return `${g.ticketKey ? `${g.ticketKey} · ` : ""}${g.title} · ${chipLabel(g.top)} · ${g.top.why} · ${age(g.top, now)}${more}`;
}

/** An open group's row stands for its top need, which is listed under it; says so, since j and k step past that one. */
export function firstText(g: NeedGroup): string {
  return `${g.title}, ${g.count} waiting here. First: ${g.top.ticketKey ? `${g.top.ticketKey} ` : ""}${g.top.title}. Enter decides it.`;
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
 * "Approve N safe drafts" under a group's needs. It opens the combined preview of what each would do, with its confirm, in
 * the decision pane like any other decision (`BatchDecision`): the same step the step rail's button asks.
 */
function SafeBatch({ needs, gid, aside }: { needs: readonly Need[]; gid: string; aside: number }) {
  const proposals = useWorkspace((s) => s.proposals);
  const open = usePipHome((s) => s.batch === gid);
  const count = needs.filter((n) => n.target.type === "draft" && proposals[n.target.id]).length;
  // The drafts from the person's own reply are never in the batch; with the button gone for want of a second draft, the note says why.
  const note = aside > 0 && count + aside >= 2;
  if (count < 2 && !note) return null;
  return (
    <li data-needs-you-batch className="grid gap-1.5 px-2 py-1">
      {count >= 2 && (
        <div>
          <button
            type="button"
            aria-current={open ? "true" : undefined}
            title={BATCH_TITLE}
            onClick={() => usePipHome.getState().previewBatch(gid)}
            className="rounded-md border border-ws-sep2 px-2.5 py-px text-sm font-semibold text-ws-ink hover:bg-ws-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ws-pip"
          >
            {batchLabel(count)}
          </button>
        </div>
      )}
      {note && (
        <p data-batch-aside className="m-0 text-xs text-ws-ink3">
          {BATCH_ASIDE}
        </p>
      )}
    </li>
  );
}

function NeedRow({ need, gid, now, onPick, showTicket, top }: { need: Need; gid: string; now: number; onPick?(need: Need): void; showTicket: boolean; top: boolean }) {
  const deciding = usePipHome((s) => s.deciding === need.key);
  // A draft the person edited and has not posted says so, and a comment's title follows the words as edited.
  const { edited, text: typed } = useEditedDraft(need.target.type === "draft" ? need.target.id : "");
  const title = editedTitle(need.title, typed);
  const text = `${need.head ? `${need.head} · ` : ""}${title}${edited ? " · edited" : ""} · ${age(need, now)}`;
  return (
    <li>
      <button
        type="button"
        data-needs-you-need={need.key}
        data-need-key={need.key}
        data-gid={gid}
        // The group's own row above is this need too: j and k step past it, so an open group is no longer than its needs.
        data-needs-top={top ? "" : undefined}
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
          <span data-needs-you-need-title title={title} className="line-clamp-2 min-w-0 flex-1 [overflow-wrap:anywhere] text-ws-ink">
            {title}
          </span>
          {edited && (
            <span data-needs-you-edited className="shrink-0 text-xs font-semibold text-ws-pip">
              edited
            </span>
          )}
          <GroupChip group={need.group} label={chipLabel(need)} />
          <span className="shrink-0 text-xs text-ws-ink3">{age(need, now)}</span>
        </span>
        <Asking need={need} />
      </button>
    </li>
  );
}

/** Pip home's list opens its groups by default while this many needs or fewer wait, so each shows once, under its group. */
const OPEN_BY_DEFAULT = 8;

function GroupRow({ group: g, now, onPick, openByDefault }: { group: NeedGroup; now: number; onPick?(need: Need): void; openByDefault: boolean }) {
  const gid = groupId(g.workstreamId);
  const open = usePipHome((s) => s.expanded.has(gid) || (openByDefault && !s.collapsed.has(gid)));
  const deciding = usePipHome((s) => s.deciding === g.top.key);
  const text = groupText(g, now);
  const list = `needs-you-group-${gid}`;
  const expanded = g.count > 1 && open;
  const proposals = useWorkspace((s) => s.proposals);
  // The top need's draft, edited and not posted, says so; open, the need's own row does.
  const { edited } = useEditedDraft(g.top.target.type === "draft" ? g.top.target.id : "");
  const asideCount = [g.top, ...g.rest].filter((n) => n.target.type === "draft" && proposals[n.target.id] && isAnswersDraft(proposals[n.target.id])).length;
  return (
    <li data-needs-you-row={gid} className="grid has-[[data-needs-you-group]:focus-visible]:[&_[data-needs-top]]:outline-2 has-[[data-needs-you-group]:focus-visible]:[&_[data-needs-top]]:outline-dashed has-[[data-needs-you-group]:focus-visible]:[&_[data-needs-top]]:outline-offset-[-2px] has-[[data-needs-you-group]:focus-visible]:[&_[data-needs-top]]:outline-ws-pip">
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
        title={expanded ? firstText(g) : text}
        aria-label={expanded ? firstText(g) : undefined}
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
          {/* Open, the group is only its name and count: the needs under it say the rest, each once. */}
          {expanded ? (
            <span data-needs-you-count-chip title={`${g.count} waiting in ${g.workstreamId === null ? "General" : "this workstream"}; the count above is the total`} className="shrink-0 text-xs text-ws-ink3">
              {g.count} here
            </span>
          ) : (
            <GroupChip group={g.top.group} label={chipLabel(g.top)} />
          )}
        </span>
        {!expanded && (
        <span data-needs-you-why className="line-clamp-2 text-xs text-ws-ink2 [overflow-wrap:anywhere]">
          {/* General holds needs about any ticket, so its row names the top one's. */}
          {g.workstreamId === null && g.top.ticketKey && <b className="font-mono font-semibold text-ws-ink">{g.top.ticketKey} </b>}
          {g.top.why}
        </span>
        )}
        {!expanded && <Asking need={g.top} />}
      </button>
      <div className="flex items-center gap-1.5 px-2 pb-0.5 text-xs text-ws-ink3">
        {!expanded && <span data-needs-you-age>{age(g.top, now)}</span>}
        {!expanded && edited && (
          <span data-needs-you-edited className="font-semibold text-ws-pip">
            edited
          </span>
        )}
        {g.count > 1 && (
          <button
            type="button"
            data-needs-you-more
            aria-expanded={expanded}
            aria-controls={list}
            aria-label={expanded ? `Show less of what needs you in ${g.title}` : `+${g.count - 1} more that need you in ${g.title}`}
            onClick={() => usePipHome.getState().setExpanded(gid, !expanded)}
            className="rounded px-1 font-semibold text-ws-accent hover:underline focus-visible:outline-2 focus-visible:outline-ws-pip"
          >
            {expanded ? "Show less" : `+${g.count - 1} more`}
          </button>
        )}
      </div>
      {expanded && (
        <ul id={list} data-needs-you-needs aria-label={`Everything that needs you in ${g.title}`} className="m-0 grid list-none gap-0.5 border-l border-ws-sep pl-1.5 ml-2 p-0">
          {[g.top, ...g.rest].map((n) => (
            <NeedRow key={n.key} need={n} gid={gid} now={now} onPick={onPick} top={n === g.top} showTicket={g.workstreamId === null || n.ticketKey !== g.ticketKey} />
          ))}
          <SafeBatch needs={g.safeBatch} gid={gid} aside={asideCount} />
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
    <section aria-label="Needs you" data-needs-you className={`grid min-h-0 content-start gap-1 overflow-y-auto ${compact ? "max-h-[min(400px,60vh)] p-2" : main ? "max-h-1/2 shrink px-1.5 pb-2" : "max-h-[38vh] border-t border-ws-sep pt-2"}`}>
      <h2 data-needs-you-title tabIndex={-1} className={`sticky top-0 z-10 m-0 flex items-center gap-1.5 px-1 outline-none font-semibold tracking-wide uppercase ${main ? "bg-ws-bar pt-2 pb-1 text-sm text-ws-ink2" : "bg-ws-win text-xs text-ws-ink3"}`}>
        Needs you
        <span data-needs-you-count aria-label={`${needs.length} waiting`} className={`rounded-full px-1.5 text-[10px] ${needs.length ? "bg-ws-pip text-ws-on-pip" : "bg-ws-hover text-ws-ink3"}`}>
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
            <GroupRow key={groupId(g.workstreamId)} group={g} now={now} onPick={onPick} openByDefault={main && needs.length <= OPEN_BY_DEFAULT} />
          ))}
        </ul>
      )}
    </section>
  );
}
