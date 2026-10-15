import { useEffect, useMemo, useRef, useState } from "react";
import type { Need } from "../lib/needs";
import { WEEK_PICKS, isoWeek, itemOutcome, liveWorkstreamOf, movePick, planMyWeek, reopenedWithoutWorkstream, ticketDone, ticketPick, weekLabel, type PlanItem } from "../lib/planMyWeek";
import type { WorkstreamWither } from "../lib/workstreamWither";
import type { PersonRef, WorkItem } from "../types";
import { useWorkspace } from "../workspaceStore";
import { usePipHome } from "./pipHomeStore";
import { usePrefs } from "./prefs";
import { useRuns } from "./runsStore";
import { focusPeekOf } from "./PeekSheet";
import { runDayAction } from "./StartMyDay";
import { showPlanMyWeek } from "./planActions";
import { useToasts } from "./toasts";
import { offerUndo, withdrawUndo } from "./undo";
import { useNow } from "./useNow";
import { openOnPipHome, useWorkstreams } from "./workstreamsStore";

const button = "rounded-md border border-ws-sep2 px-2.5 py-px text-sm leading-normal whitespace-nowrap hover:bg-ws-hover focus-visible:outline-2 focus-visible:outline-ws-pip";
const small = "rounded px-1.5 text-sm leading-normal text-ws-ink2 hover:bg-ws-hover focus-visible:outline-2 focus-visible:outline-ws-pip disabled:opacity-40";

/** What the card says when there is nothing to propose. */
export const PLAN_EMPTY = "Nothing to propose: no open workstream or ticket assigned to you is free to work on. You can add a ticket below.";

/** What the proposal's intro says about what it does not plan, in one line: what waits on others is answered in Needs you. */
/** Why a need can be missing from the picks: there are only so many, and the rest are answered where they wait. */
export const PLAN_LEFT_OUT = `It proposes ${WEEK_PICKS}; more that needs you stays in Needs you, where it is answered rather than planned.`;

/** How many matches the choice list shows at most. */
export const CHOICES = 5;

/** What the words name: the ticket, several tickets to choose from (the person's own first), a ticket that is in the plan already (its key), or nothing open. */
export type TicketFound = { ticket: WorkItem } | { choices: WorkItem[] } | { reason: "taken"; key: string } | { reason: "done"; key: string } | { reason: "doneMany" } | { reason: "none" };

/**
 * The open ticket the words name: its key, or else the tickets whose title contains them. One match is that ticket; several are
 * a list of up to `CHOICES` to choose from, those assigned to one of `me` first (as the list holds them otherwise), never a silent pick of one.
 * Says so when the only matches are in the plan already, or when the key or the title words name only Done tickets in Jira, apart from when none matches.
 */
export function findTicket(words: string, items: readonly WorkItem[], taken: readonly PlanItem[], me: readonly PersonRef[] = []): TicketFound {
  const q = words.trim().toLowerCase();
  if (!q) return { reason: "none" };
  const open = items.filter((t) => t.status.category !== "done");
  const byKey = open.find((t) => t.item.key.toLowerCase() === q) ?? open.find((t) => t.item.key.toLowerCase() === q.split(/\s+/)[0]);
  const matches = byKey ? [byKey] : open.filter((t) => t.title.toLowerCase().includes(q));
  if (!matches.length) {
    // A Done ticket is never planned, but "no open ticket" would leave the person wondering whether the key is wrong.
    const done = items.find((t) => t.status.category === "done" && (t.item.key.toLowerCase() === q || t.item.key.toLowerCase() === q.split(/\s+/)[0]));
    if (done) return { reason: "done", key: done.item.key };
    const doneByTitle = items.filter((t) => t.status.category === "done" && t.title.toLowerCase().includes(q));
    return doneByTitle.length === 1 ? { reason: "done", key: doneByTitle[0].item.key } : doneByTitle.length ? { reason: "doneMany" } : { reason: "none" };
  }
  // The same key on another connection is another ticket; a pick kept before connections were stored blocks by key alone.
  const free = matches.filter((t) => !taken.some((p) => p.ticketKey === t.item.key && (p.connectionId === undefined || p.connectionId === t.item.connectionId)));
  if (!free.length) return { reason: "taken", key: matches[0].item.key };
  if (free.length === 1) return { ticket: free[0] };
  const mine = (t: WorkItem) => !!t.assignee && me.some((m) => m.connectionId === t.assignee!.connectionId && m.accountId === t.assignee!.accountId);
  return { choices: [...free.filter(mine), ...free.filter((t) => !mine(t))].slice(0, CHOICES) };
}

/** Which way a key moves between the plan's rows: ArrowDown or j on, ArrowUp or k back; 0 for any other key, and for one with a modifier (Alt+arrow moves the row itself). */
export function rowStep(ev: Pick<KeyboardEvent, "key" | "altKey" | "ctrlKey" | "metaKey" | "shiftKey">): 1 | -1 | 0 {
  if (ev.altKey || ev.ctrlKey || ev.metaKey || ev.shiftKey) return 0;
  return ev.key === "ArrowDown" || ev.key === "j" ? 1 : ev.key === "ArrowUp" || ev.key === "k" ? -1 : 0;
}

/** The pick the keyboard goes to once the one at `index` is removed from `picks` (as they are after): the one now at that index, else the one before it; null when none is left (the add box takes it). */
export const afterRemove = (picks: readonly PlanItem[], index: number): string | null => (picks[index] ?? picks[index - 1])?.id ?? null;

/** The plan with `pick` put back at `index` (or the end, when the plan is shorter by now): what Undo does after a removal. Null when the pick is in the plan again, so there is nothing to put back. */
export function restorePick(picks: readonly PlanItem[], pick: PlanItem, index: number): PlanItem[] | null {
  if (picks.some((x) => x.id === pick.id)) return null;
  return [...picks.slice(0, index), pick, ...picks.slice(index)];
}

/** Where the keyboard goes once a pick moved by its ↑ or ↓ button: the same button in its new row, the other one when that is off at the end of the list, else the row. */
export function afterMove(part: "up" | "down", index: number, count: number): "up" | "down" | "row" {
  const off = (p: "up" | "down") => (p === "up" ? index === 0 : index === count - 1);
  return !off(part) ? part : !off(part === "up" ? "down" : "up") ? (part === "up" ? "down" : "up") : "row";
}

/** Brings the choice list into view in the day scroller it sits in, clear of the sticky Keep row (the list's scroll margin). */
export const revealChoices = (group: Pick<HTMLElement, "scrollIntoView"> | null | undefined) => group?.scrollIntoView({ block: "nearest" });

/** The card itself: pure of the stores, so a test can render it. */
export function PlanMyWeekView({
  week,
  picks,
  kept,
  tickets,
  me,
  onChange,
  onKeep,
  onClose,
  onPropose,
}: {
  week: string;
  picks: readonly PlanItem[];
  /** The week already has a kept plan. */
  kept: boolean;
  tickets: readonly WorkItem[];
  /** The signed-in person's accounts: their own tickets come first among several matches. */
  me?: readonly PersonRef[];
  onChange(next: PlanItem[]): void;
  onKeep(): void;
  onClose(): void;
  onPropose(): void;
}) {
  const [adding, setAdding] = useState("");
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [drag, setDrag] = useState<number | null>(null);
  /** Several tickets matched the words: the person chooses one. */
  const [choices, setChoices] = useState<WorkItem[] | null>(null);
  const [focus, setFocus] = useState<{ id: string; part: "row" | "up" | "down" } | { removed: number } | null>(null);
  const root = useRef<HTMLElement>(null);
  // What Undo puts back goes into the plan as it is by then, which the closure of the press that removed the row cannot see.
  const latest = useRef({ picks, onChange });
  latest.current = { picks, onChange };
  const offered = useRef<number[]>([]);
  // The plan is only on this card until it is kept: once it goes, an Undo offered for it has nothing to put back into.
  useEffect(() => () => offered.current.forEach((id) => withdrawUndo(id)), []);
  // After a move or a remove the row has remounted in its new place or gone: the keyboard follows the row (its own button, when a button moved it), or lands on the pick that took the removed one's place.
  useEffect(() => {
    if (!focus || !root.current) return;
    const find = (sel: string) => root.current?.querySelector<HTMLElement>(sel);
    const row = (id: string) => find(`[data-plan-pick="${CSS.escape(id)}"]`);
    if ("removed" in focus) {
      const near = afterRemove(picks, focus.removed);
      (near ? row(near) : find("[data-plan-add]"))?.focus();
    } else {
      const li = row(focus.id);
      const at = picks.findIndex((p) => p.id === focus.id);
      const part = focus.part === "row" ? "row" : afterMove(focus.part, at, picks.length);
      (part === "row" ? li : li?.querySelector<HTMLElement>(`[data-plan-move="${part}"]`))?.focus();
    }
    setFocus(null);
  }, [focus, picks]);
  const move = (from: number, to: number) => {
    if (to < 0 || to >= picks.length || from === to) return;
    onChange(movePick(picks, from, to));
  };
  /** Takes the pick at `index` out, with an Undo for it (the Remove button and Delete or Backspace on its row alike). */
  const remove = (index: number) => {
    const gone = picks[index];
    if (!gone) return;
    onChange(picks.filter((x) => x.id !== gone.id));
    setFocus({ removed: index });
    offered.current.push(
      offerUndo({
        text: `Removed ${gone.title} from the plan.`,
        undone: `Put ${gone.title} back in the plan.`,
        async undo() {
          // Added again meanwhile: nothing to put back.
          const back = restorePick(latest.current.picks, gone, index);
          if (!back) return false;
          latest.current.onChange(back);
        },
        restored: () => setFocus({ id: gone.id, part: "row" }),
      }),
    );
  };
  const addTicket = (t: WorkItem) => {
    const pick = ticketPick(t);
    onChange([...picks, pick]);
    // The choice button (or the Add button) that was focused is gone or behind: the keyboard goes to the new row.
    setFocus({ id: pick.id, part: "row" });
    setNote({ ok: true, text: `Added ${t.item.key} ${t.title}` });
    setAdding("");
    setChoices(null);
  };
  const add = () => {
    const found = findTicket(adding, tickets, picks, me);
    if ("choices" in found) return (setNote(null), setChoices(found.choices));
    if (!("ticket" in found)) return setNote({ ok: false, text: found.reason === "taken" ? `${found.key} is in the plan already.` : found.reason === "done" ? `${found.key} is Done in Jira.` : found.reason === "doneMany" ? "Only Done tickets match that." : "No open ticket matches that." });
    addTicket(found.ticket);
  };
  // The list appears under the field, and the keyboard goes to its first choice.
  useEffect(() => {
    if (!choices) return;
    root.current?.querySelector<HTMLElement>("[data-plan-choice]")?.focus();
    revealChoices(root.current?.querySelector<HTMLElement>("[data-plan-choices]"));
  }, [choices]);
  return (
    <section
      ref={root}
      data-plan-my-week
      data-esc-local
      aria-labelledby="plan-my-week"
      tabIndex={-1}
      onKeyDown={(ev) => {
        if (ev.key === "Escape" && !ev.defaultPrevented) (ev.stopPropagation(), onClose());
      }}
      className="grid gap-2 border-b border-ws-sep bg-ws-bar px-3 py-2 outline-none"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h2 id="plan-my-week" className="m-0 min-w-0 flex-1 text-sm font-semibold text-ws-ink">
          Plan my week <span className="font-normal text-ws-ink3">· {weekLabel(week)}</span>
        </h2>
        <button type="button" data-plan-propose onClick={onPropose} className={`${button} border-transparent text-ws-ink2 underline`}>
          {kept ? "Start over" : "Propose again"}
        </button>
        <button type="button" data-plan-close onClick={onClose} className={button}>
          Close
        </button>
      </div>
      <p data-plan-intro className="m-0 text-sm text-ws-ink3">
        Pip's proposal from your open workstreams and the tickets assigned to you: what needs you first, then the oldest and most pressing, leaving out what is waiting or held. <span data-plan-left-out>{PLAN_LEFT_OUT}</span> Nothing is written to Jira.
      </p>
      {picks.length === 0 ? (
        <p data-plan-empty className="m-0 text-sm text-ws-ink3">
          {PLAN_EMPTY}
        </p>
      ) : (
        <ol aria-label="This week's plan" aria-keyshortcuts="ArrowUp ArrowDown j k Alt+ArrowUp Alt+ArrowDown Delete" className="m-0 grid list-none gap-1 p-0 text-sm">
          {picks.map((p, n) => (
            <li
              key={p.id}
              data-plan-pick={p.id}
              tabIndex={0}
              draggable
              aria-label={`${n + 1}. ${p.title}. ${p.because} Alt and the arrow keys move it.`}
              onDragStart={() => setDrag(n)}
              onDragOver={(ev) => drag !== null && ev.preventDefault()}
              onDrop={(ev) => {
                ev.preventDefault();
                if (drag !== null) move(drag, n);
                setDrag(null);
              }}
              onDragEnd={() => setDrag(null)}
              onKeyDown={(ev) => {
                // Plain arrows (or j and k) step between the rows, from the row itself; its own buttons keep their keys.
                const step = ev.target === ev.currentTarget ? rowStep(ev) : 0;
                if (step) {
                  ev.preventDefault();
                  ev.stopPropagation();
                  const rows = Array.from(root.current?.querySelectorAll<HTMLElement>("[data-plan-pick]") ?? []);
                  return void rows[Math.max(0, Math.min(rows.length - 1, n + step))]?.focus();
                }
                // Delete or Backspace on the row removes it, as its Remove button does, with the same Undo.
                if (ev.target === ev.currentTarget && !ev.altKey && !ev.ctrlKey && !ev.metaKey && (ev.key === "Delete" || ev.key === "Backspace")) {
                  ev.preventDefault();
                  ev.stopPropagation();
                  return remove(n);
                }
                if (!ev.altKey || (ev.key !== "ArrowUp" && ev.key !== "ArrowDown")) return;
                ev.preventDefault();
                ev.stopPropagation();
                const to = ev.key === "ArrowUp" ? n - 1 : n + 1;
                if (to >= 0 && to < picks.length) (move(n, to), setFocus({ id: p.id, part: "row" }));
              }}
              className={`flex min-w-0 items-baseline gap-2 rounded-md border border-ws-sep px-2 py-1 outline-none focus-visible:outline-2 focus-visible:outline-ws-pip ${drag === n ? "opacity-50" : ""}`}
            >
              <span aria-hidden className="shrink-0 font-semibold text-ws-ink3">
                {n + 1}
              </span>
              <span className="grid min-w-0 flex-1">
                <span data-plan-title className="truncate font-semibold text-ws-ink">{p.title}</span>
                <span data-plan-because className="text-ws-ink2">
                  Because {p.because}
                </span>
              </span>
              <button type="button" data-plan-move="up" aria-label={`Move ${p.title} up`} disabled={n === 0} onClick={() => (move(n, n - 1), setFocus({ id: p.id, part: "up" }))} className={small}>
                ↑
              </button>
              <button type="button" data-plan-move="down" aria-label={`Move ${p.title} down`} disabled={n === picks.length - 1} onClick={() => (move(n, n + 1), setFocus({ id: p.id, part: "down" }))} className={small}>
                ↓
              </button>
              <button type="button" data-plan-remove aria-label={`Remove ${p.title}`} onClick={() => remove(n)} className={small}>
                Remove
              </button>
            </li>
          ))}
        </ol>
      )}
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(ev) => {
          ev.preventDefault();
          add();
        }}
      >
        <input
          type="text"
          data-plan-add
          aria-label="Add a ticket by key or title"
          placeholder="Add a ticket: key or words"
          value={adding}
          onChange={(ev) => (setAdding(ev.target.value), setNote(null), setChoices(null))}
          className="min-w-[10rem] flex-1 rounded-md border border-ws-sep2 bg-ws-win px-2 py-0.5 text-sm text-ws-ink focus-visible:outline-2 focus-visible:outline-ws-pip"
        />
        <button type="submit" data-plan-add-go className={button}>
          Add
        </button>
        {note && (
          <span role="status" {...{ [note.ok ? "data-plan-added" : "data-plan-missing"]: true }} className={`min-w-0 truncate text-sm ${note.ok ? "text-ws-ink2" : "text-ws-blocked"}`}>
            {note.text}
          </span>
        )}
      </form>
      {choices && (
        <div
          role="group"
          data-plan-choices
          data-esc-local
          aria-label={`${choices.length} tickets match; choose one`}
          onKeyDown={(ev) => {
            const list = Array.from(ev.currentTarget.querySelectorAll<HTMLElement>("[data-plan-choice]"));
            const at = list.indexOf(document.activeElement as HTMLElement);
            if (ev.key === "Escape") {
              ev.stopPropagation();
              setChoices(null);
              return void root.current?.querySelector<HTMLElement>("[data-plan-add]")?.focus();
            }
            const to = ev.key === "ArrowDown" || ev.key === "j" ? at + 1 : ev.key === "ArrowUp" || ev.key === "k" ? at - 1 : null;
            if (to === null || !list.length) return;
            ev.preventDefault();
            list[Math.max(0, Math.min(list.length - 1, to))].focus();
          }}
          className="grid max-h-48 scroll-mb-12 gap-0.5 overflow-y-auto rounded-md border border-ws-sep p-1 text-sm"
        >
          <p className="m-0 px-1 text-xs text-ws-ink3">Several tickets match “{adding.trim()}”. Choose one (↑ ↓ and Enter; Esc cancels).</p>
          {choices.map((t) => (
            <button key={t.item.key} type="button" data-plan-choice={t.item.key} onClick={() => addTicket(t)} className="flex scroll-mb-12 min-w-0 items-baseline gap-2 rounded px-1.5 py-0.5 text-left text-ws-ink2 hover:bg-ws-hover focus-visible:outline-2 focus-visible:outline-ws-pip">
              <b className="shrink-0 font-mono font-semibold text-ws-ink">{t.item.key}</b>
              <span className="min-w-0 truncate">{t.title}</span>
              {t.assignee && me?.some((m) => m.connectionId === t.assignee!.connectionId && m.accountId === t.assignee!.accountId) && <span className="ml-auto shrink-0 text-xs text-ws-ink3">assigned to you</span>}
            </button>
          ))}
        </div>
      )}
      {/* Sticky: the card scrolls in a box of its own, and an open choice list would otherwise push Keep out of sight. */}
      <div data-plan-keep-row className="sticky bottom-0 z-10 flex items-center gap-2 border-t border-ws-sep bg-ws-bar py-1.5">
        <button type="button" data-plan-keep onClick={onKeep} className={`${button} border-ws-pip bg-ws-pip font-semibold text-ws-on-pip`}>
          Keep this plan
        </button>
        <span className="text-sm text-ws-ink3">
          {kept ? `Kept on this device for the ${weekLabel(week)}; it shows as This week on Pip home.` : "Keep this plan to see it as This week on Pip home; it stays on this device."}
        </span>
      </div>
    </section>
  );
}

/** Plan my week on Pip home: the proposal (or the plan already kept this week) to reorder, trim, add to and keep. */
export function PlanMyWeek({ needs, withers, now }: { needs: readonly Need[]; withers: Readonly<Record<string, WorkstreamWither>>; now: number }) {
  const list = useWorkstreams((s) => s.list);
  const items = useWorkspace((s) => s.items);
  const me = useWorkspace((s) => s.me);
  const runs = useRuns((s) => s.runs);
  const learning = usePrefs((s) => s.clarityLearning);
  const week = isoWeek(new Date(now));
  const keptPlan = usePrefs((s) => s.weekPlans[week]);
  const tickets = useMemo(() => Object.values(items), [items]);
  const propose = () => planMyWeek({ workstreams: list, items: tickets, me, needs, runs, withers, learning, now: new Date(now), count: WEEK_PICKS });
  const [picks, setPicks] = useState<PlanItem[]>(() => keptPlan?.items ?? propose());
  const [fresh, setFresh] = useState(!keptPlan);
  const close = (toThisWeek = false) => {
    usePipHome.getState().setPlanOpen(false);
    const row = () => document.querySelector<HTMLElement>('[data-pip-home-column="list"] [role="option"][tabindex="0"]')?.focus();
    if (!toThisWeek) return void requestAnimationFrame(row);
    // Kept, the person's next stop is the This week list that has just appeared: it renders a frame or two after the card goes.
    let tries = 8;
    const toList = () => {
      const el = document.querySelector<HTMLElement>("[data-this-week] button");
      if (el) return el.focus();
      if (--tries > 0) requestAnimationFrame(toList);
      else row();
    };
    requestAnimationFrame(toList);
  };
  return (
    <PlanMyWeekView
      week={week}
      picks={picks}
      kept={!!keptPlan && !fresh}
      tickets={tickets}
      me={me}
      onChange={setPicks}
      onPropose={() => (setPicks(propose()), setFresh(true))}
      onKeep={() => {
        usePrefs.getState().keepWeekPlan(picks, new Date(now));
        useToasts.getState().push(`Kept your plan for the ${weekLabel(week)}. Nothing was sent to Jira.`, "info");
        close(true);
      }}
      onClose={() => close()}
    />
  );
}

/** Shows a ticket in the peek and hands the keyboard to it, so the next Tab is the peek's own. */
export function openTicketItem(key: string) {
  runDayAction({ type: "ticket", key });
  focusPeekOf(key);
}

/** Opens what a kept item points at: its workstream while it is open (or the open one on its ticket, once its own closed), else its ticket. */
function openItem(item: PlanItem, done: boolean) {
  const live = done ? null : liveWorkstreamOf(item, useWorkstreams.getState().list);
  if (live) return openOnPipHome(live);
  if (item.workstreamId && !done) return openOnPipHome(item.workstreamId);
  if (item.ticketKey) return openTicketItem(item.ticketKey);
  if (item.workstreamId) openOnPipHome(item.workstreamId);
}

/** Starts a workstream again on a reopened item's ticket, which opens it on Pip home; an item whose ticket isn't cached opens the ticket instead. */
function startAgain(item: PlanItem) {
  const ticket = Object.values(useWorkspace.getState().items).find((t) => t.item.key === item.ticketKey && (item.connectionId === undefined || t.item.connectionId === item.connectionId));
  if (ticket) void useWorkstreams.getState().start(ticket.item);
  else if (item.ticketKey) runDayAction({ type: "ticket", key: item.ticketKey });
}

/** What a ticked item says about itself, for its tooltip and its name: a closed workstream whose ticket isn't Done is dropped work, not finished work. */
export const CLOSED_NOT_DONE = "Closed, not done";
const CLOSED_TITLE = "The workstream was closed but the ticket isn't Done in Jira, so this isn't ticked as finished.";

/** The compact "This week" list in Pip home's left column: the kept plan, each item a link, ticked once it is done, and marked apart ("closed, not done") once its workstream closed with the ticket not Done. A ticked or closed item can be reopened. Nothing while no plan is kept. */
export function ThisWeekView({
  week,
  items,
  done,
  closed = new Set<string>(),
  stopped = new Set<string>(),
  jiraDone = new Set<string>(),
  onOpen,
  onEdit,
  onReopen,
  onStart,
}: {
  week: string;
  items: readonly PlanItem[];
  /** Items finished: ticked. */
  done: ReadonlySet<string>;
  /** Items whose workstream closed with the ticket not Done: muted, with another mark. */
  closed?: ReadonlySet<string>;
  /** Reopened items whose workstream is closed: open in the list, with no workstream to go to. */
  stopped?: ReadonlySet<string>;
  /** Reopened items whose ticket is Done in Jira: the closed workstream is no unfinished work, so they say so and offer no new start. */
  jiraDone?: ReadonlySet<string>;
  onOpen(item: PlanItem): void;
  onEdit(): void;
  /** Takes a done or closed item back to open; the list shows no button without it. */
  onReopen?(item: PlanItem): void;
  /** Starts a workstream on a reopened item whose workstream is closed; the list shows no button without it. */
  onStart?(item: PlanItem): void;
}) {
  return (
    <section data-this-week={week} aria-label="This week" className="grid max-h-[25%] min-h-0 shrink-0 grid-rows-[auto_minmax(0,1fr)] gap-0.5 border-t border-ws-sep bg-ws-bar px-3 py-1.5">
      <div className="flex items-baseline gap-2">
        <h2 className="m-0 flex-1 text-xs font-semibold tracking-wide text-ws-ink3 uppercase">This week</h2>
        <button type="button" data-this-week-edit onClick={onEdit} className="rounded px-1 text-xs text-ws-ink2 underline hover:bg-ws-hover focus-visible:outline-2 focus-visible:outline-ws-pip">
          Edit
        </button>
      </div>
      <ul className="m-0 grid max-h-28 min-h-0 list-none gap-0 overflow-y-auto p-0 text-sm">
        {items.map((p) => {
          const isDone = done.has(p.id);
          const isClosed = !isDone && closed.has(p.id);
          return (
            <li key={p.id} data-this-week-item={p.id} data-done={isDone || undefined} data-closed={isClosed || undefined} title={isClosed ? CLOSED_TITLE : undefined} className="flex min-w-0 items-baseline gap-1.5">
              <span aria-hidden className={isDone ? "text-ws-done" : "text-ws-ink3"}>
                {isDone ? "✓" : isClosed ? "⊘" : "○"}
              </span>
              <button
                type="button"
                onClick={() => onOpen(p)}
                aria-label={`${isDone ? "Done: " : isClosed ? `${CLOSED_NOT_DONE}: ` : ""}${p.title}`}
                className={`min-w-0 rounded text-left hover:underline focus-visible:outline-2 focus-visible:outline-ws-pip ${isDone ? "truncate text-ws-ink3 line-through" : isClosed ? "text-ws-ink2 italic [overflow-wrap:anywhere]" : "truncate text-ws-ink2"}`}
              >
                {p.title}
              </button>
              {isClosed && (
                <span data-this-week-closed className="shrink-0 text-xs text-ws-ink3">
                  closed, not done
                </span>
              )}
              {!isDone && !isClosed && stopped.has(p.id) && (
                <>
                  <span data-this-week-stopped className="shrink-0 text-xs text-ws-ink3">
                    {jiraDone.has(p.id) ? "Done in Jira" : "workstream closed"}
                  </span>
                  {onStart && p.ticketKey && !jiraDone.has(p.id) && (
                    <button type="button" data-this-week-start aria-label={`Start a workstream on ${p.title}`} onClick={() => onStart(p)} className="shrink-0 rounded px-1 text-xs text-ws-ink2 underline hover:bg-ws-hover focus-visible:outline-2 focus-visible:outline-ws-pip">
                      Start again
                    </button>
                  )}
                </>
              )}
              {(isDone || isClosed) && onReopen && (
                <button type="button" data-this-week-reopen aria-label={`Reopen ${p.title}`} onClick={() => onReopen(p)} className="shrink-0 rounded px-1 text-xs text-ws-ink2 underline hover:bg-ws-hover focus-visible:outline-2 focus-visible:outline-ws-pip">
                  Reopen
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export function ThisWeek() {
  const now = useNow(60_000);
  const week = isoWeek(new Date(now));
  const plan = usePrefs((s) => s.weekPlans[week]);
  const list = useWorkstreams((s) => s.list);
  const closed = useWorkstreams((s) => s.closed);
  const items = useWorkspace((s) => s.items);
  const has = !!plan && plan.items.length > 0;
  // An item is ticked when its workstream closed, and the closed ones are read once a plan is there to tick.
  useEffect(() => {
    if (has) void useWorkstreams.getState().loadClosed();
  }, [has, list.length]);
  const { done, dropped, jiraDone } = useMemo(() => {
    const views = [...list, ...closed];
    const tickets = Object.values(items);
    const outcomes = (plan?.items ?? []).map((p) => [p.id, itemOutcome(p, views, tickets)] as const);
    return {
      done: new Set(outcomes.filter(([, o]) => o === "done").map(([id]) => id)),
      dropped: new Set(outcomes.filter(([, o]) => o === "closed").map(([id]) => id)),
      jiraDone: new Set((plan?.items ?? []).filter((p) => ticketDone(p, views, tickets)).map((p) => p.id)),
    };
  }, [plan, list, closed, items]);
  if (!plan || !has) return null;
  const stopped = new Set(plan.items.filter((p) => reopenedWithoutWorkstream(p, [...list, ...closed])).map((p) => p.id));
  return <ThisWeekView week={week} items={plan.items} done={done} closed={dropped} stopped={stopped} jiraDone={jiraDone} onStart={startAgain} onOpen={(p) => openItem(p, done.has(p.id) || dropped.has(p.id))} onEdit={showPlanMyWeek} onReopen={(p) => usePrefs.getState().reopenWeekPlanItem(week, p.id)} />;
}
