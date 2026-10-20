import type { ReactNode } from "react";
import { FILTER_LABEL, TIMELINE_FILTERS, type TimelineFilter } from "../lib/timeline";
import { useTabs } from "./tabsStore";

const SEGMENT = "inline-flex gap-0.5 rounded-[7px] border border-ws-sep2 p-0.5";
const segment = (on: boolean) => `rounded-[5px] px-2 py-px text-sm focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ws-pip ${on ? "bg-ws-sel font-semibold text-ws-ink" : "text-ws-ink2 hover:bg-ws-hover"}`;

/** What the Drafts and Decisions counts are: history, not the live Needs-you count. */
const countTitle = (n: number | undefined) => (n === undefined ? undefined : `${n} in this timeline, decided or waiting. What needs you now is in Needs you.`);

/**
 * The timeline's filters: All, Runs, Drafts, Decisions. It heads the timeline in the Pip
 * pane. `counts` adds how many each shows; `after` is what follows the buttons (the scope, the pane's way to the runs of
 * every workstream). `label` names the
 * group: the pane's is its own, so it never reads as the main timeline's.
 */
export function TimelineFilterBar({ value, onChange, counts, after, label = "Timeline filter" }: { value: TimelineFilter; onChange(filter: TimelineFilter): void; counts?: Partial<Record<TimelineFilter, number>>; after?: ReactNode; label?: string }) {
  return (
    <div data-timeline-filter={value} className="flex flex-wrap items-center gap-2">
      <div role="group" aria-label={label} className={SEGMENT}>
        {TIMELINE_FILTERS.map((f) => (
          <button key={f} type="button" aria-pressed={value === f} data-filter={f} title={f === "drafts" || f === "decisions" ? countTitle(counts?.[f]) : undefined} onClick={() => onChange(f)} className={segment(value === f)}>
            {FILTER_LABEL[f]}
            {counts?.[f] !== undefined && (
              <>
                {" "}
                <span data-filter-count className="font-normal text-ws-ink3">
                  {counts[f]}
                </span>
              </>
            )}
          </button>
        ))}
      </div>
      {after}
    </div>
  );
}

/** The Agents screen: every run across every workstream, what is running, the capacity, Stop all. */
export function showAllRuns() {
  useTabs.getState().setRoute("agents");
}
