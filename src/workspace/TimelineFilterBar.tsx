import type { ReactNode } from "react";
import { FILTER_LABEL, TIMELINE_FILTERS, type TimelineFilter } from "../lib/timeline";
import { useTabs } from "./tabsStore";
import { Segmented } from "../components/Segmented";


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
      <Segmented
        label={label}
        value={value}
        onChange={onChange}
        options={TIMELINE_FILTERS.map((f) => ({
          value: f,
          title: f === "drafts" || f === "decisions" ? countTitle(counts?.[f]) : undefined,
          attrs: { "data-filter": f },
          label: (
            <>
              {FILTER_LABEL[f]}
              {counts?.[f] !== undefined && (
                <>
                  {" "}
                  <span data-filter-count className="font-normal text-ws-ink3">
                    {counts[f]}
                  </span>
                </>
              )}
            </>
          ),
        }))}
      />
      {after}
    </div>
  );
}

/** The Agents screen: every run across every workstream, what is running, the capacity, Stop all. */
export function showAllRuns() {
  useTabs.getState().setRoute("agents");
}
