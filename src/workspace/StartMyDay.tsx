import { useMemo, useState } from "react";
import { itemKey } from "../lib/filter";
import type { Need } from "../lib/needs";
import { dayKey } from "./activityLogic";
import { DAY_ENTRIES, startMyDay, startMyDayShown, type DayAction, type DayEntry, type DayLine, type StartMyDay } from "../lib/startMyDay";
import type { WorkstreamWither } from "../lib/workstreamWither";
import { useWorkspace } from "../workspaceStore";
import { openTicketByKey } from "./jump";
import { openNeed } from "./needsActions";
import { showPlanMyWeek } from "./planActions";
import { usePipHome } from "./pipHomeStore";
import { usePrefs } from "./prefs";
import { useTabs } from "./tabsStore";
import { openOnPipHome, useWorkstreams } from "./workstreamsStore";

const button = "rounded-md border border-ws-sep2 px-2.5 py-px text-sm leading-normal whitespace-nowrap hover:bg-ws-hover focus-visible:outline-2 focus-visible:outline-ws-pip";

/** What the card is, and what Done for now does. */
export const DAY_ABOUT = "Once a day: what needs you, what is stuck and what may be unclear. Nothing is posted. Done for now hides it until tomorrow; ⌘K brings it back.";
export const DONE_HINT = "Hides Start my day until tomorrow. ⌘K brings it back.";

/** What the card says when there is nothing to start with. */
export const DAY_EMPTY = "Nothing needs you, no reporter is silent, and nothing has gone quiet in Jira.";

/** Runs what an entry's button does: opens the need, the workstream, the ticket, or drafts the nudge (for approval, never posted). */
export function runDayAction(action: DayAction) {
  switch (action.type) {
    case "need":
      return openNeed(action.need);
    case "workstream":
      return openOnPipHome(action.id);
    case "nudge":
      return void useWorkstreams.getState().nudgeReporter(action.id);
    case "ticket": {
      // The peek opens over Pip home; a ticket that isn't synced is read live.
      const cached = Object.values(useWorkspace.getState().items).find((i) => i.item.key === action.key);
      if (cached) return useTabs.getState().select(itemKey(cached.item));
      return void openTicketByKey(action.key);
    }
  }
}

/** Start my day, from what Pip home already holds: Needs you, the workstreams, their cobwebs, the drafts and the cached tickets. */
export function useStartMyDay(needs: readonly Need[], withers: Readonly<Record<string, WorkstreamWither>>, now: number): StartMyDay {
  const list = useWorkstreams((s) => s.list);
  const proposals = useWorkspace((s) => s.proposals);
  const items = useWorkspace((s) => s.items);
  const me = useWorkspace((s) => s.me);
  const learning = usePrefs((s) => s.clarityLearning);
  return useMemo(
    () => startMyDay({ needs, workstreams: list.filter((v) => v.workstream.closedAt === null), withers, proposals: Object.values(proposals), items: Object.values(items), me, learning, now: new Date(now) }),
    [needs, list, withers, proposals, items, me, learning, now],
  );
}

/** Where focus goes when the card closes from its button, so the keyboard stays on Pip home: the list's current row. */
function focusList() {
  document.querySelector<HTMLElement>('[data-pip-home-column="list"] [role="option"][tabindex="0"]')?.focus();
}

/** Sets the card aside for today and keeps the keyboard where it was. */
export function doneForNow(now = new Date()) {
  const hadFocus = typeof document !== "undefined" && document.activeElement?.closest("[data-start-my-day]") != null;
  usePrefs.getState().setStartMyDayDoneOn(dayKey(now));
  if (hadFocus) requestAnimationFrame(focusList);
}

/** ⌘K "Start my day": brings the card back on Pip home, whether or not it was set aside today, and puts the keyboard on it. */
export function showStartMyDay() {
  usePrefs.getState().setStartMyDayDoneOn(null);
  usePipHome.getState().closeDecision();
  useTabs.getState().setRoute("pip");
  // The card mounts on the next render, once Pip home is on screen.
  let tries = 0;
  const focus = () => {
    const card = document.querySelector<HTMLElement>("[data-start-my-day]");
    if (card) return card.focus();
    if (++tries < 60) requestAnimationFrame(focus);
  };
  requestAnimationFrame(focus);
}

function Entry({ entry }: { entry: DayEntry }) {
  return (
    <li data-day-entry={entry.key} className="flex min-w-0 items-baseline gap-2">
      <span className="min-w-0 flex-1 text-ws-ink2">{entry.text}</span>
      <button type="button" data-day-action onClick={() => runDayAction(entry.action)} aria-label={`${entry.label}: ${entry.text}`} className={button}>
        {entry.label}
      </button>
    </li>
  );
}

export function DayLineView({ line, initiallyOpen = false }: { line: DayLine; initiallyOpen?: boolean }) {
  // "and N more" is a button, so what the card cuts off is reachable by keyboard too.
  const [open, setOpen] = useState(initiallyOpen);
  const all = [...line.entries, ...(line.rest ?? [])];
  // A long list of tickets that may be unclear is a notice, not a decision: its title carries the count and More lists them, so it does not push the lines that need the person off the card.
  const collapsed = line.kind === "unclear" && line.count > DAY_ENTRIES;
  const entries = open ? all : collapsed ? [] : line.entries;
  // What the button says; its name adds which line it expands, as several lines have one.
  const more = open ? "Show fewer" : collapsed ? "More" : `Show ${line.more} more`;
  return (
    <section data-day-line={line.kind} aria-label={line.title} className="grid gap-0.5">
      <h3 className="m-0 text-sm font-semibold text-ws-ink">{line.title}</h3>
      <ul className="m-0 grid list-none gap-0.5 p-0 text-sm">
        {entries.map((e) => (
          <Entry key={e.key} entry={e} />
        ))}
        {(collapsed || line.more > 0) &&
          (collapsed || line.rest?.length ? (
            <li>
              <button type="button" data-day-more aria-expanded={open} aria-label={`${more}: ${line.title}`} onClick={() => setOpen(!open)} className="rounded px-1 text-ws-ink2 underline hover:bg-ws-hover focus-visible:outline-2 focus-visible:outline-ws-pip">
                {more}
              </button>
            </li>
          ) : (
            <li className="text-ws-ink3">and {line.more} more</li>
          ))}
      </ul>
    </section>
  );
}

/** The card itself: pure of the stores, so a test can render it. */
export function StartMyDayView({ day, onDone, onSent, onPlan }: { day: StartMyDay; onDone(): void; onSent(): void; onPlan?(): void }) {
  return (
    // Not a region of its own: Pip home's labelled stop around it already is "Start my day".
    <div data-start-my-day tabIndex={-1} className="grid gap-2 border-b border-ws-sep bg-ws-bar px-3 py-2 outline-none">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h2 id="start-my-day" className="m-0 min-w-0 flex-1 text-sm font-semibold text-ws-ink">
          Start my day
        </h2>
        {onPlan && (
          <button type="button" data-day-plan onClick={onPlan} className={`${button} border-transparent text-ws-ink2 underline`}>
            Plan my week
          </button>
        )}
        <button type="button" data-day-sent onClick={onSent} className={`${button} border-transparent text-ws-ink2 underline`}>
          What Jira saw from me
        </button>
        <button type="button" data-day-done title={DONE_HINT} onClick={onDone} className={button}>
          Done for now
        </button>
      </div>
      <p data-day-about className="m-0 text-sm text-ws-ink3">
        {DAY_ABOUT}
      </p>
      {day.empty ? (
        <p data-day-empty className="m-0 text-sm text-ws-ink3">
          {DAY_EMPTY}
        </p>
      ) : (
        day.lines.map((l) => <DayLineView key={l.kind} line={l} />)
      )}
    </div>
  );
}

/**
 * Start my day at the top of Pip home's conversation column, once a day: until the person says "Done for now", which keeps it
 * away for the rest of the day (the prefs), or while a decision is open in the pane, which has the room. ⌘K brings it back.
 */
export function StartMyDayCard({ needs, withers, now }: { needs: readonly Need[]; withers: Readonly<Record<string, WorkstreamWither>>; now: number }) {
  const doneOn = usePrefs((s) => s.startMyDayDoneOn);
  const deciding = usePipHome((s) => s.deciding !== null || s.batch !== null);
  if (!startMyDayShown(doneOn, new Date(now)) || deciding) return null;
  return <LiveStartMyDay needs={needs} withers={withers} now={now} />;
}

/** The card with its day worked out, only while it shows: set aside, the tickets are not read at all. */
function LiveStartMyDay({ needs, withers, now }: { needs: readonly Need[]; withers: Readonly<Record<string, WorkstreamWither>>; now: number }) {
  const day = useStartMyDay(needs, withers, now);
  return <StartMyDayView day={day} onDone={() => doneForNow(new Date(now))} onSent={() => useTabs.getState().setRoute("sent")} onPlan={showPlanMyWeek} />;
}
