import type { ReactNode } from "react";
import { FILTER_LABEL, TIMELINE_FILTERS, type TimelineFilter } from "../lib/timeline";
import { usePipHome } from "./pipHomeStore";
import { useTabs } from "./tabsStore";

/**
 * The timeline's filters: All, Runs, Drafts, Decisions. The same bar heads a workstream's timeline on Pip home and the
 * Agents screen, which is the Runs filter across every workstream. `counts` adds how many each shows; `after` is what
 * follows the buttons (the Agents screen's note, Pip home's way to the runs of every workstream).
 */
export function TimelineFilterBar({ value, onChange, counts, after }: { value: TimelineFilter; onChange(filter: TimelineFilter): void; counts?: Partial<Record<TimelineFilter, number>>; after?: ReactNode }) {
  return (
    <div data-timeline-filter={value} className="flex flex-wrap items-center gap-2">
      <div role="group" aria-label="Timeline filter" className="inline-flex gap-0.5 rounded-[7px] border border-ws-sep2 p-0.5">
        {TIMELINE_FILTERS.map((f) => (
          <button
            key={f}
            type="button"
            aria-pressed={value === f}
            data-filter={f}
            onClick={() => onChange(f)}
            className={`rounded-[5px] px-2 py-px text-sm focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ws-pip ${value === f ? "bg-ws-sel font-semibold text-ws-ink" : "text-ws-ink2 hover:bg-ws-hover"}`}
          >
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

/** Shows filter `filter` of the selected workstream's timeline on Pip home; Runs across every workstream is the Agents screen. */
export function showTimeline(filter: TimelineFilter) {
  usePipHome.getState().setTimelineFilter(filter);
  useTabs.getState().setRoute("pip");
}

/** The Agents screen: the Runs filter across every workstream. */
export function showAllRuns() {
  useTabs.getState().setRoute("agents");
}
