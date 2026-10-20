import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Cobweb } from "../components/Cobweb";
import { isoWeek } from "../lib/planMyWeek";
import { needsIn } from "../lib/needs";
import { witherTitle } from "../lib/workstreamWither";
import type { WorkstreamView } from "../types";
import { ORIENTATION_WORDS, PipOrientation } from "./PipOrientation";
import { PlanMyWeek, ThisWeek } from "./PlanMyWeek";
import { StartMyDayCard } from "./StartMyDay";
import { StatusPill, useWorkstreamStatus } from "./StatusPill";
import { START_WORKSTREAM } from "./commands";
import { DecisionShownContext, decisionShown } from "./decisionShown";
import { InlineStartContext } from "./InlineStart";
import { usePrefs } from "./prefs";
import { groupId } from "./needsActions";
import { useNeedsYou } from "./useNeeds";
import { useNow } from "./useNow";
import { useWorkstreamWithers } from "./useWorkstreamWithers";
import { useWorkView } from "./workViewStore";
import { useWorkstreams } from "./workstreamsStore";

/** The ticket's key comes first on its own, so the title loses it when it starts with it, as a workstream's title does. */
export function rowTitle(ws: Pick<WorkstreamView["workstream"], "itemKey" | "title">): string {
  const key = ws.itemKey;
  return key && ws.title.startsWith(key) ? ws.title.slice(key.length).trim() || ws.title : ws.title;
}

/** Whether the person asked for less motion: the fade's scroll then jumps instead of gliding. */
const reducedMotion = () => !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/** How far, and how, the fade scrolls a box `clientHeight` tall: most of a page, gliding unless the person asked for less motion. */
export const fadeScroll = (clientHeight: number, reduced: boolean): ScrollToOptions => ({ top: clientHeight * 0.8, behavior: reduced ? "auto" : "smooth" });

/** Whether a scroller with these measures has more below what shows (a few pixels of slack are not more). */
export const hasMoreBelow = (el: Pick<HTMLElement, "scrollHeight" | "scrollTop" | "clientHeight">) => el.scrollHeight - el.scrollTop - el.clientHeight > 4;

/** Whether the scroller on `ref` has more below what shows, kept up to date as it scrolls and resizes. */
function useMoreBelow<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [more, setMore] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setMore(hasMoreBelow(el));
    measure();
    el.addEventListener("scroll", measure, { passive: true });
    const watch = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    watch?.observe(el);
    for (const c of Array.from(el.children)) watch?.observe(c);
    return () => (el.removeEventListener("scroll", measure), watch?.disconnect());
  });
  return [ref, more] as const;
}

/**
 * The labelled stop above the list that holds Start my day or Plan my week: a region that scrolls when the card is taller
 * than its share (a third of the window at most, or nearly half for Plan my week, whose three picks should show), with a
 * fade at the foot while something is cut off, so the scroll is not hidden.
 */
export const DAY_CAP = { start: "max-h-[30vh]", tall: "max-h-[min(45vh,26rem)]" } as const;

export function DayScroll({ label, children, tall = false }: { label: string; children: ReactNode; tall?: boolean }) {
  const [box, more] = useMoreBelow<HTMLDivElement>();
  return (
    // Focusable so the keyboard can scroll it when it overflows: a scroller with no focusable child is out of the arrow keys' reach.
    <div ref={box} data-agents-day role="region" aria-label={label} tabIndex={0} className={`relative ${tall ? DAY_CAP.tall : DAY_CAP.start} shrink-0 overflow-y-auto rounded-[10px] border border-ws-sep outline-none empty:hidden focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ws-pip`}>
      {children}
      {more && (
        <div data-day-fade aria-hidden="true" onClick={() => box.current?.scrollBy(fadeScroll(box.current.clientHeight, reducedMotion()))} className="sticky bottom-0 -mt-7 cursor-pointer bg-gradient-to-t from-ws-bar via-ws-bar/90 to-transparent pt-4 pb-0.5 text-center text-xs text-ws-ink3">
          More below ↓
        </div>
      )}
    </div>
  );
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

/** "What the words mean": the glossary's button, once the first-run card in Pip's drawer has been dismissed; it opens the words above the list. */
export function WordsButton() {
  const seen = usePrefs((s) => s.pipOrientationSeen);
  const open = useWorkView((s) => s.wordsOpen);
  if (!seen) return null;
  return (
    <button type="button" data-orientation-link aria-expanded={open} onClick={() => useWorkView.getState().setWordsOpen(!open)} className="rounded-md px-2 py-px text-sm text-ws-ink2 hover:bg-ws-hover focus-visible:outline-2 focus-visible:outline-ws-pip">
      {ORIENTATION_WORDS}
    </button>
  );
}

/** Plan my week or, asked for with ⌘K, Start my day, over the list, and the kept plan as This week. */
export function DayAndWeek() {
  const needs = useNeedsYou();
  const now = useNow();
  const list = useWorkstreams((s) => s.list);
  const planOpen = useWorkView((s) => s.planOpen);
  const openList = useMemo(() => list.filter((v) => v.workstream.closedAt === null), [list]);
  const withers = useWorkstreamWithers(openList, now);
  const words = useWorkView((s) => s.wordsOpen);
  const seen = usePrefs((s) => s.pipOrientationSeen);
  return (
    <>
      {words && seen && <PipOrientation open onDismiss={() => useWorkView.getState().setWordsOpen(false)} />}
      <DayScroll label={planOpen ? "Plan my week" : "Start my day"} tall={planOpen}>
        {planOpen ? <PlanMyWeek key={isoWeek(new Date(now))} needs={needs} withers={withers} now={now} /> : <StartMyDayCard needs={needs} withers={withers} now={now} />}
      </DayScroll>
      <ThisWeek />
    </>
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

/**
 * What a workstream's heading in the Agents list adds: where it stands (the status word and its one short detail), how much
 * of Needs you is in it, and its cobweb once it has gone quiet in Jira while work went on.
 */
export function useWorkstreamWeb(view: WorkstreamView | undefined) {
  const now = useNow();
  const open = useMemo(() => (view ? [view] : []), [view]);
  const withers = useWorkstreamWithers(open, now);
  return view ? withers[view.workstream.id] : undefined;
}

export function WorkstreamHeadExtras({ view }: { view: WorkstreamView }) {
  const status = useWorkstreamStatus(view);
  const needs = useNeedsYou();
  const web = useWorkstreamWeb(view);
  const mine = needsIn(needs, view.workstream.id);
  return (
    <>
      <StatusPill status={status} detail />
      <NeedsBadge count={mine} total={needs.length} />
      {web && (
        <span data-workstream-wither title={witherTitle(web)} className="sr-only">
          {web.text}
        </span>
      )}
      {web && <Cobweb level={web.level} />}
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
      <WordsButton />
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

