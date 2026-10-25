import { useMemo, type ReactNode } from "react";
import { needsIn } from "../lib/needs";
import type { WorkstreamView } from "../types";
import { StatusPill, useWorkstreamStatus } from "./StatusPill";
import { START_WORKSTREAM } from "./commands";
import { DecisionShownContext, decisionShown } from "./decisionShown";
import { InlineStartContext } from "./InlineStart";
import { usePrefs } from "./prefs";
import { groupId } from "./needsActions";
import { useNeedsYou } from "./useNeeds";
import { useWorkView } from "./workViewStore";
import { useWorkstreams } from "./workstreamsStore";

/** The ticket's key comes first on its own, so the title loses it when it starts with it, as a workstream's title does. */
export function rowTitle(ws: Pick<WorkstreamView["workstream"], "itemKey" | "title">): string {
  const key = ws.itemKey;
  return key && ws.title.startsWith(key) ? ws.title.slice(key.length).trim() || ws.title : ws.title;
}

/**
 * Wraps what shows a workstream or a decision so that the one open in a workstream's Needs you is not shown a second time (the
 * timeline, the step rail, the controls), and run drafts that need nothing chosen are read and started in place.
 */
export function DecisionScope({ children }: { children: ReactNode }) {
  const needs = useNeedsYou();
  const deciding = useWorkView((s) => s.deciding);
  const list = useWorkstreams((s) => s.list);
  const open = useWorkView((s) => s.selected);
  // Only while its workstream's detail, which holds the decision, is open.
  const decided = useMemo(() => {
    const need = needs.find((n) => n.key === deciding);
    return decisionShown(need && groupId(need.workstreamId) === open ? need : null, list);
  }, [needs, deciding, list, open]);
  return (
    <InlineStartContext.Provider value={true}>
      <DecisionShownContext.Provider value={decided}>{children}</DecisionShownContext.Provider>
    </InlineStartContext.Provider>
  );
}

/** "1 needs you", "3 need you"; nothing when nothing does. */
export function NeedsBadge({ count, total }: { count: number; total: number }) {
  if (!count) return null;
  return (
    <span data-needs-you-badge title={`${count} of the ${total} in Needs you ${count === 1 ? "is" : "are"} here`} className="shrink-0 rounded-full bg-ws-pip px-1.5 text-[10px] leading-4 font-semibold text-ws-on-pip">
      {count} {count === 1 ? "needs" : "need"} you
    </span>
  );
}

/** What a workstream's heading in the Agents list adds: where it stands (the status word and its one short detail) and how much of Needs you is in it. */
export function WorkstreamHeadExtras({ view }: { view: WorkstreamView }) {
  const status = useWorkstreamStatus(view);
  const needs = useNeedsYou();
  const mine = needsIn(needs, view.workstream.id);
  return (
    <>
      <StatusPill status={status} detail />
      <NeedsBadge count={mine} total={needs.length} />
    </>
  );
}

/** What the list says before there is any workstream: what one is, in a line. */
export const NO_WORKSTREAMS = "No workstreams yet. A workstream follows one ticket from investigation to a reviewed pull request, with Pip keeping track.";

/** "Start a workstream…" and "Show closed", the two ways to the workstreams the list doesn't show. */
export function WorkstreamTools({ showClosed, onShowClosed }: { showClosed: boolean; onShowClosed(on: boolean): void }) {
  const button = "rounded-md px-2 py-px text-sm text-ws-ink2 hover:bg-ws-hover focus-visible:outline-2 focus-visible:outline-ws-pip";
  return (
    <>
      {/* The palette, already asking for a workstream: the person types the ticket, and its 'Start a workstream on' starts it. */}
      <button type="button" data-start-workstream onClick={() => usePrefs.getState().setPaletteOpen(true, START_WORKSTREAM)} className={button}>
        Start a workstream…
      </button>
      <button type="button" data-show-closed aria-pressed={showClosed} onClick={() => onShowClosed(!showClosed)} className={button}>
        {showClosed ? "Hide closed" : "Show closed"}
      </button>
    </>
  );
}

/** The closed workstreams, read-only, each with a Reopen the backend refuses while the ticket has another open workstream. */
export function ClosedWorkstreams({ closed, open }: { closed: readonly WorkstreamView[]; open: readonly WorkstreamView[] }) {
  return (
    <section aria-label="Closed workstreams" data-closed-workstreams className="grid gap-2">
      <h3 className="m-0 text-xs font-semibold tracking-[0.05em] text-ws-ink2 uppercase">Closed workstreams</h3>
      <ul className="m-0 grid list-none gap-0.5 p-0">
        {closed.map((v) => {
          const key = v.workstream.itemKey;
          // The backend refuses a reopen while the ticket has another open workstream: say so instead of pressing a button that does nothing.
          const blocked = key ? open.some((o) => o.workstream.itemKey === key) : false;
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
    </section>
  );
}

