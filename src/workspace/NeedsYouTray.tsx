import { useEffect, useMemo, useState } from "react";
import { relativeTime } from "../lib/views";
import { useWorkspace } from "../workspaceStore";
import { lastHeldAt, needsYouItems, type NeedsYouItem } from "./pipHomeLogic";
import { usePipHome } from "./pipHomeStore";
import { useRuns } from "./runsStore";
import { useTabs } from "./tabsStore";
import { useWorkstreams } from "./workstreamsStore";

/**
 * When each held open workstream was last held, read from its audit once per hold, so a hold sorts in the tray by when
 * it happened rather than by when the workstream opened. Only reads.
 */
function useHeldTimes(): Record<string, string> {
  const backend = useWorkstreams((s) => s.backend);
  const holds = useWorkstreams((s) =>
    s.list
      .filter((v) => v.workstream.closedAt === null && v.workstream.heldReason)
      .map((v) => `${v.workstream.id}\n${v.workstream.heldReason}`)
      .join("\t"),
  );
  const [times, setTimes] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!backend || !holds) return;
    let live = true;
    const ids = holds.split("\t").map((h) => h.split("\n")[0]);
    void Promise.all(ids.map((id) => backend.workstreamsEvents(id).then((events) => [id, lastHeldAt(events)] as const, () => [id, null] as const))).then((read) => {
      if (live) setTimes(Object.fromEntries(read.filter((r): r is readonly [string, string] => r[1] !== null)));
    });
    return () => {
      live = false;
    };
  }, [backend, holds]);
  return times;
}

/** Everything waiting on the person across the workstreams and General, oldest first, kept current from the live stores. */
export function useNeedsYou(): NeedsYouItem[] {
  const workstreams = useWorkstreams((s) => s.list);
  const runs = useRuns((s) => s.runs);
  const seenFailed = useRuns((s) => s.seenFailed);
  const proposals = useWorkspace((s) => s.proposals);
  const heldAt = useHeldTimes();
  return useMemo(() => needsYouItems({ workstreams, runs, proposals: Object.values(proposals), seenFailed, heldAt }), [workstreams, runs, proposals, seenFailed, heldAt]);
}

/**
 * Goes to what `item` waits on: Pip home (from any other route), the item's workstream or General, and the card to bring
 * into view. A run's sheet opens over it too, where its question or permission is answered as it is today. It decides
 * nothing itself.
 */
export function openNeedsYou(item: NeedsYouItem) {
  const tabs = useTabs.getState();
  if (tabs.route !== "pip") tabs.setRoute("pip");
  const home = usePipHome.getState();
  if (item.workstreamId) home.openWorkstream(item.workstreamId);
  else home.openGeneral();
  home.focus(item.target);
  if (item.target.type === "run") useRuns.getState().openRun(item.target.id, { stay: true });
}

/** An item's line: its label, and how long it has waited, except for a hold, which says what it says. */
export function needsYouText(item: NeedsYouItem, now: Date): string {
  return item.kind === "held" ? item.label : `${item.label} · ${relativeTime(item.at, now)}`;
}

export interface NeedsYouTrayProps {
  items: readonly NeedsYouItem[];
  /** The rail's popover form: no border of its own, a shorter list. */
  compact?: boolean;
  /** Called with the item activated, before going to it; the popover closes itself with it. */
  onPick?(item: NeedsYouItem): void;
  /** The current time, for the ages; a test passes its own. */
  now?: Date;
}

/** The Needs you tray: a count, then each thing waiting on the person, oldest first. Activating one goes to it. */
export function NeedsYouTray({ items, compact = false, onPick, now = new Date() }: NeedsYouTrayProps) {
  return (
    <section aria-label="Needs you" data-needs-you className={`grid min-h-0 gap-1 ${compact ? "p-2" : "border-t border-ws-sep pt-2"}`}>
      <h3 className="m-0 flex items-center gap-1.5 px-1 text-xs font-semibold tracking-wide text-ws-ink3 uppercase">
        Needs you
        <span data-needs-you-count className={`rounded-full px-1.5 text-[10px] ${items.length ? "bg-ws-pip text-ws-on-pip" : "bg-ws-hover text-ws-ink3"}`}>
          {items.length}
        </span>
      </h3>
      {items.length === 0 ? (
        <p className="m-0 px-1 text-sm text-ws-ink3">Nothing needs you.</p>
      ) : (
        <ul className={`m-0 grid list-none gap-0.5 overflow-y-auto p-0 ${compact ? "max-h-[min(320px,50vh)]" : "max-h-[30vh]"}`}>
          {items.map((item) => (
            <li key={item.key}>
              <button
                type="button"
                data-needs-you-item={item.key}
                data-kind={item.kind}
                onClick={() => {
                  onPick?.(item);
                  openNeedsYou(item);
                }}
                className="w-full truncate rounded px-2 py-1 text-left text-sm text-ws-ink2 hover:bg-ws-hover focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ws-pip"
              >
                {needsYouText(item, now)}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
